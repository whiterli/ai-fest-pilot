use crate::model::{clean, date_key, normalize_invoice, Book, Change, Message, Order, Rule, Terms};
use serde::Serialize;
use std::{collections::{BTreeMap, HashMap}, sync::Arc};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status { Ready, Review, Fix, Hold, Duplicate, Replaced, Info }

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ready => "Сверен",
            Self::Review => "Нужно уточнение",
            Self::Fix => "Нужно исправление",
            Self::Hold => "Проверить реквизиты",
            Self::Duplicate => "Повтор",
            Self::Replaced => "Заменён",
            Self::Info => "Переписка",
        }
    }

    pub fn requires_action(self) -> bool {
        matches!(self, Self::Review | Self::Fix | Self::Hold)
    }
}

#[derive(Serialize)]
pub struct Outcome {
    pub status: Status,
    title: &'static str,
    pub explanation: String,
    pub action: &'static str,
    pub rules: &'static [&'static str],
    pub recipient: String,
    draft: String,
    pub delta: Option<f64>,
    quantity: Option<f64>,
    price: Option<f64>,
    terms: Option<Terms>,
}

impl Outcome {
    fn new(status: Status, title: &'static str, explanation: impl Into<String>, action: &'static str, rules: &'static [&'static str]) -> Self {
        Self { status, title, explanation: explanation.into(), action, rules, recipient: String::new(),
            draft: String::new(), delta: None, quantity: None, price: None, terms: None }
    }

    fn request(mut self, recipient: impl Into<String>, draft: String) -> Self {
        self.recipient = recipient.into();
        self.draft = draft;
        self
    }

    fn converted(mut self, quantity: f64, price: f64, terms: Terms) -> Self {
        self.quantity = Some(quantity);
        self.price = Some(price);
        self.terms = Some(terms);
        self
    }
}

#[derive(Serialize)]
pub struct Entry {
    #[serde(flatten)] pub message: Message,
    pub order: Option<Arc<Order>>,
    pub changes: Vec<Arc<Change>>,
    #[serde(flatten)] pub result: Outcome,
    pub related: Option<String>,
}

#[derive(Serialize)]
pub struct Dataset {
    pub entries: Vec<Entry>,
    pub rules: BTreeMap<String, Rule>,
}

fn display_number(value: f64, decimals: usize) -> String {
    let formatted = format!("{:.*}", decimals, value.abs());
    let (integer, fraction) = formatted.split_once('.').unwrap_or((&formatted, ""));
    let mut output = String::with_capacity(formatted.len() + 8);
    if value < 0.0 { output.push('-'); }
    for (index, digit) in integer.chars().enumerate() {
        if index > 0 && (integer.len() - index) % 3 == 0 { output.push('\u{a0}'); }
        output.push(digit);
    }
    let fraction = fraction.trim_end_matches('0');
    if !fraction.is_empty() {
        output.push(',');
        output.push_str(fraction);
    }
    output
}

fn money(value: f64) -> String { format!("{} ₽", display_number(value, 2)) }
fn quantity(value: f64, unit: &str) -> String { format!("{} {unit}", display_number(value, 3)) }
fn cents(value: f64) -> f64 { (value * 100.0 + 0.5).floor() / 100.0 }
fn nonempty<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() { fallback } else { value }
}

fn match_order<'a>(message: &Message, book: &'a Book, by_party: &HashMap<&str, Vec<&'a Arc<Order>>>) -> Option<&'a Arc<Order>> {
    if !message.stated_order.is_empty() {
        return book.orders.get(&message.stated_order);
    }
    let candidates = by_party.get(message.party.as_str())?;
    let mut matching = candidates.iter().copied().filter(|order| {
        !message.material.conflicts(&order.specs)
            && (message.material.has_shared_spec(&order.specs) || clean(&message.material_text) == clean(&order.material))
            && message.units_for(order).map(|(count, _)| count) == order.ordered
            && message.raw_quantity.is_some() && order.ordered.is_some()
            && (message.order_date.is_none() || message.order_date == order.date)
    });
    let first = matching.next()?;
    matching.next().is_none().then_some(first)
}

fn check(message: &Message, order: Option<&Order>, changes: &[Arc<Change>], payee: Option<&Message>, earlier: f64) -> Outcome {
    let invoice = &message.invoice;
    let id = order.map_or(message.stated_order.as_str(), |order| order.id.as_str());
    let buyer = nonempty(order.map_or("", |order| &order.buyer), "Закупщик");
    let ask = |title, explanation, action, rules, draft| {
        Outcome::new(Status::Review, title, explanation, action, rules).request(buyer, draft)
    };
    if message.changes_payee || payee.is_some() || order.is_some_and(|order| order.party != message.party) {
        let explanation = payee.map_or_else(
            || "В письме заявлена смена получателя или банка либо поставщик расходится с данными заказа.".into(),
            |related| format!("В письме {} поставщик просит сменить реквизиты по счёту №{invoice}.", related.id));
        let order_reference = if id.is_empty() { String::new() } else { format!(", заказ {id}") };
        return Outcome::new(Status::Hold, "Нужно подтвердить получателя платежа", explanation,
            "Передать закупщику и финансовому директору для проверки подписанного допсоглашения в Directum RX.", &["П-2"])
            .request(format!("{buyer} и финансовый директор"), format!(
                "По счёту №{}{order_reference} требуется подтверждение реквизитов. Проверьте, пожалуйста, подписанное допсоглашение и актуального получателя платежа в Directum RX.",
                nonempty(invoice, "—")));
    }
    let Some(order) = order else {
        let explanation = if id.is_empty() {
            "По поставщику, материалу, количеству и дате не удалось однозначно определить заказ.".into()
        } else { format!("Заказ {id} отсутствует в выгрузке.") };
        let supplier = message.sender.split(',').next().unwrap_or_default().replace(['«', '»'], "");
        return ask("Заказ требует уточнения", explanation, "Запросить номер заказа и уточнить принадлежность счёта.",
            &["П-1"], format!("Уточните, пожалуйста, номер заказа для счёта №{} от «{supplier}».", nonempty(invoice, "—")));
    };
    if invoice.is_empty() {
        return ask("Не указан номер счёта", "Номер нужен для проверки повторов у поставщика.".into(),
            "Запросить номер документа.", &["П-1", "П-3"],
            format!("Уточните, пожалуйста, номер счёта по заказу {id}."));
    }
    let valid = message.raw_quantity.filter(|value| *value > 0.0)
        .zip(message.raw_price.filter(|value| *value >= 0.0))
        .zip(message.amount.filter(|value| *value >= 0.0));
    let Some(((raw_quantity, raw_price), amount)) = valid else {
        return ask("Не хватает данных счёта", "Для сверки нужны количество, цена за единицу и итоговая сумма.".into(),
            "Уточнить данные позиции по оригиналу счёта.", &["П-7", "П-8"],
            format!("По счёту №{invoice} к заказу {id} уточните, пожалуйста, количество, единицу измерения, цену и итоговую сумму."));
    };
    let expected = cents(raw_quantity * raw_price);
    let delta = cents(amount - expected);
    if delta != 0.0 {
        let mut result = Outcome::new(Status::Fix, "Итог счёта не сходится",
            format!("{} × {} = {}. В счёте указано {}.", quantity(raw_quantity, &message.raw_unit), money(raw_price), money(expected), money(amount)),
            "Запросить исправленный счёт у поставщика.", &["П-8"]).request(&order.supplier,
            format!("По счёту №{invoice}, заказ {id}, расчёт по позиции даёт {}, а в документе указано {}. Пришлите, пожалуйста, исправленный счёт.", money(expected), money(amount)));
        result.delta = Some(delta);
        return result;
    }
    if message.material.conflicts(&order.specs) {
        return ask("Характеристики товара различаются",
            format!("В заказе {id} указан материал «{}». Характеристики в счёте отличаются.", order.material),
            "Уточнить у закупщика, к какой позиции относится счёт.", &["П-1", "П-7"],
            format!("Подтвердите, пожалуйста, материал в счёте №{invoice} по заказу {id}. В ERP указано «{}».", order.material));
    }
    let Some((count, price)) = message.units_for(order) else {
        return ask("Нужно подтвердить фасовку",
            format!("Счёт в единице «{}», заказ в «{}».", nonempty(&message.raw_unit, "не указана"), order.unit),
            "Запросить коэффициент пересчёта в единицу заказа.", &["П-7"],
            format!("Уточните, пожалуйста, фасовку в счёте №{invoice} по заказу {id}, чтобы пересчитать позицию в «{}».", order.unit));
    };
    let terms = Terms::new(order, changes);
    let future_lot = message.delivery.as_ref().filter(|date| order.receipt_date.is_none() || date_key(date) > order.receipt_date);
    if future_lot.is_some() || order.received.is_none_or(|received| count > received - earlier) {
        let receipt = match (future_lot, order.received) {
            (Some(date), _) => format!("В счёте указана отдельная партия к {date}. Её приёмка в выгрузке не подтверждена."),
            (_, None) => "Данные о проведённой приёмке отсутствуют.".into(),
            (_, Some(received)) => {
                let previous = if earlier == 0.0 { String::new() }
                    else { format!(", в других сверенных счетах уже учтено {}", quantity(earlier, &order.unit)) };
                format!("В счёте {}, в учёте принято {}{previous}.", quantity(count, &order.unit), quantity(received, &order.unit))
            }
        };
        let draft = format!("По счёту №{invoice}, заказ {id}: {receipt} Подтвердите, пожалуйста, условия оплаты и предоплаты по договору.");
        return ask("Не хватает проведённой приёмки", receipt,
            "Запросить условия оплаты и предоплаты у закупщика. При необходимости подтвердить поступление у склада.",
            &["П-4", "П-5", "П-9"], draft).converted(count, price, terms);
    }
    if terms.ordered.is_none_or(|ordered| count + earlier > ordered) {
        let allowed = terms.ordered.map_or_else(|| "не указано".into(), |value| quantity(value, &order.unit));
        return ask("Количество выше согласованного", format!(
            "С учётом других сверенных счетов предъявлено {}. В заказе согласовано {allowed}.", quantity(count + earlier, &order.unit)),
            "Уточнить у закупщика, как оформить сверхпоставку.", &["П-6", "П-9"],
            format!("По счёту №{invoice} к заказу {id} количество выше согласованного. Подтвердите, пожалуйста, основание для сверхпоставки."))
            .converted(count, price, terms);
    }
    if terms.uncertain || terms.price.is_none_or(|agreed| (price - agreed).abs() > 0.000001) {
        let comparable = terms.price.filter(|_| !terms.uncertain);
        let delta = comparable.map(|agreed| cents(amount - count * agreed));
        let explanation = match comparable.zip(delta) {
            Some((agreed, delta)) => format!(
                "В счёте {} за {}, действует {} за {}. Расхождение по сумме — {}.", money(price), order.unit, money(agreed), order.unit, money(delta)),
            None => "Выгрузки недостаточно, чтобы подтвердить действующую цену этой партии.".into(),
        };
        let draft = format!("По счёту №{invoice}, заказ {id}: {explanation} Подтвердите, пожалуйста, действующую цену и пришлите основание.");
        let mut result = ask("Нужно подтвердить цену", explanation,
            "Проверить у закупщика подписанное согласование для этого заказа и партии.", &["П-6", "П-9"], draft)
            .converted(count, price, terms);
        result.delta = delta;
        return result;
    }
    let conversion = message.package_size.filter(|size| *size > 0.0).map_or_else(String::new, |size| format!(
        "{} × {} = {}. ", quantity(raw_quantity, &message.raw_unit), quantity(size, &order.unit), quantity(count, &order.unit)));
    Outcome::new(Status::Ready, "Данные счёта сходятся",
        format!("{conversion}Подтверждено {} по {}. Итог — {}.", quantity(count, &order.unit), money(price), money(amount)),
        "Передать бухгалтеру для дальнейшей проверки перед подготовкой платежа.", &["П-1", "П-4", "П-6", "П-7", "П-8"])
        .converted(count, price, terms)
}

fn same_amounts(left: &Message, right: &Message) -> bool {
    left.amount.is_some() && left.amount == right.amount
        && left.raw_quantity == right.raw_quantity && left.raw_price == right.raw_price
}

type InvoiceKey<'a> = (&'a str, &'a str);

pub fn reconcile(book: &Book, added: &[Message]) -> Dataset {
    let messages = book.messages.iter().chain(added);
    let mut orders_by_party: HashMap<&str, Vec<&Arc<Order>>> = HashMap::new();
    for order in book.orders.values() {
        orders_by_party.entry(&order.party).or_default().push(order);
    }
    let mut changes_by_order: HashMap<&str, Vec<Arc<Change>>> = HashMap::new();
    for change in &book.changes {
        changes_by_order.entry(&change.order).or_default().push(Arc::clone(change));
    }
    let mut payee_messages: HashMap<InvoiceKey<'_>, Vec<&Message>> = HashMap::new();
    for message in messages.clone().filter(|item| item.changes_payee && !item.invoice.is_empty()) {
        payee_messages.entry((&message.party, normalize_invoice(&message.invoice))).or_default().push(message);
    }
    let mut exact: HashMap<InvoiceKey<'_>, usize> = HashMap::new();
    let mut versions_by_base: HashMap<InvoiceKey<'_>, Vec<usize>> = HashMap::new();
    let mut accepted: HashMap<String, f64> = HashMap::new();
    let mut entries: Vec<Entry> = Vec::with_capacity(book.messages.len() + added.len());
    let mut entry_messages: Vec<&Message> = Vec::with_capacity(entries.capacity());
    for message in messages {
        let matched = match_order(message, book, &orders_by_party);
        let invoice = normalize_invoice(&message.invoice);
        let base = invoice.split('/').next().unwrap_or_default();
        let key = (message.party.as_str(), invoice);
        let base_key = (message.party.as_str(), base);
        let version = if invoice.is_empty() || message.party.is_empty() { None } else {
            exact.get(&key).copied().or_else(|| {
                let order = matched?;
                versions_by_base.get(&base_key)?.iter().copied().find(|&index| {
                    let prior = &entries[index];
                    prior.result.status != Status::Replaced
                        && (invoice.contains('/') || prior.message.invoice.contains('/'))
                        && prior.order.as_ref().is_some_and(|prior| prior.id == order.id)
                        && same_amounts(message, &prior.message)
                })
            })
        };
        let order = matched.cloned().or_else(|| {
            if message.looks_like_bill { None } else { version.and_then(|index| entries[index].order.clone()) }
        });
        let changes = order.as_ref().and_then(|order| changes_by_order.get(order.id.as_str()))
            .cloned().unwrap_or_default();
        let mut related = version.map(|index| entries[index].message.id.clone());
        let result;
        if !message.looks_like_bill {
            result = if message.changes_payee { check(message, order.as_deref(), &changes, None, 0.0) } else {
                Outcome::new(Status::Info, "Письмо для справки", "Это сообщение дополняет переписку по заказу или счёту.",
                    "Использовать как контекст при проверке исходного документа.", &["П-1", "П-4"])
            };
        } else {
            let mut is_new = true;
            let mut existing = None;
            if let Some(index) = version {
                let prior = &mut entries[index];
                let same_order = match (&order, &prior.order) {
                    (Some(left), Some(right)) => left.id == right.id,
                    _ => true,
                };
                if same_order && message.replacement {
                    if prior.result.status == Status::Ready {
                        if let (Some(order), Some(quantity)) = (&prior.order, prior.result.quantity) {
                            *accepted.entry(order.id.clone()).or_default() -= quantity;
                        }
                    }
                    let mut replaced = Outcome::new(Status::Replaced, "Есть исправленная версия",
                        format!("Актуальная версия счёта получена в письме {}.", message.id),
                        "Открыть исправленный счёт.", &["П-3"]);
                    replaced.quantity = prior.result.quantity;
                    replaced.price = prior.result.price;
                    prior.result = replaced;
                    prior.related = Some(message.id.clone());
                    let prior_message = entry_messages[index];
                    exact.remove(&(prior_message.party.as_str(), normalize_invoice(&prior_message.invoice)));
                } else if same_order && (message.resend || (same_amounts(message, &prior.message)
                    && message.raw_unit == prior.message.raw_unit && message.package_size == prior.message.package_size
                    && message.pack_unit == prior.message.pack_unit)) {
                    is_new = false;
                    existing = Some(Outcome::new(Status::Duplicate, "Счёт уже есть в очереди",
                        format!("Письмо относится к счёту №{} от того же поставщика ({}).", prior.message.invoice, prior.message.id),
                        "Открыть исходный счёт.", &["П-1", "П-3"]));
                } else {
                    is_new = false;
                    existing = Some(Outcome::new(Status::Review, "Данные версий расходятся",
                        format!("У этого поставщика уже есть счёт с таким номером в письме {}.", prior.message.id),
                        "Уточнить, относится ли письмо к исправлению исходного счёта или к новой партии.", &["П-3"]));
                }
            }
            if let Some(existing) = existing {
                result = existing;
            } else {
                let payee = payee_messages.get(&key).and_then(|items| items.iter().copied().find(|item| item.id != message.id));
                let earlier = order.as_ref().and_then(|order| accepted.get(&order.id)).copied().unwrap_or(0.0);
                related = payee.map(|item| item.id.clone());
                result = check(message, order.as_deref(), &changes, payee, earlier);
                if result.status == Status::Ready {
                    if let (Some(order), Some(quantity)) = (&order, result.quantity) {
                        *accepted.entry(order.id.clone()).or_default() += quantity;
                    }
                }
            }
            if is_new && !invoice.is_empty() && !message.party.is_empty() {
                exact.insert(key, entries.len());
                versions_by_base.entry(base_key).or_default().push(entries.len());
            }
        }
        entries.push(Entry { message: message.clone(), order, changes, result, related });
        entry_messages.push(message);
    }
    Dataset { entries, rules: book.rules.clone() }
}
