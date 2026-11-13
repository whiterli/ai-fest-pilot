use calamine::{Data, Reader, Xlsx};
use chrono::{Days, NaiveDate};
use regex::{Captures, Regex};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    io::Cursor,
    sync::{Arc, LazyLock},
};

const SHEETS: [&str; 4] = ["Счета и письма", "Заказы и приёмка", "Согласования", "Правила"];
const MAX_ROWS: u32 = 250_003;
pub const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_XML: u64 = 256 * 1024 * 1024;
const NUM: &str = r"[0-9]+(?:[ \u{a0}\u{202f}][0-9]{3})*(?:[.,][0-9]+)?";
const UNITS: &str = r"шт(?:ук[аи]?)?|кг|рул(?:он(?:а|ов|ы)?)?|меш(?:ок|ка|ков)|пач(?:ка|ки|ек)";
const DATE: &str = r"[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{4})?";

macro_rules! pattern {
    ($name:ident, $expression:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new(&$expression).unwrap());
    };
}
pattern!(CHARGE, format!(
    r"(?i)(?P<qty>{NUM})\s*(?P<unit>{UNITS})\.?\s*(?:(?:по|×|x)\s*(?P<pack>{NUM})\s*(?P<pack_unit>{UNITS})\.?\s*,?\s*)?(?:,\s*)?(?:по\s+|цена\s*(?:(?:за\s+)?[\p{{L}}.]+\s+)?)(?P<price>{NUM})\s*(?:₽|руб)"
));
pattern!(QUANTITY, format!(r"(?i)(?P<qty>{NUM})\s*(?P<unit>{UNITS})\b"));
pattern!(AMOUNT, format!(r"(?i)(?:итого|всего|на\s+сумму)\s*[:=]?\s*({NUM})\s*(?:₽|руб)"));
pattern!(INVOICE, r"(?i)сч[её]т[уае]?\s*(?:№\s*)?([\p{L}]*[0-9][\p{L}0-9/-]*)");
pattern!(ORDER, r"(?i)ЗП\s*[-–—]\s*([0-9]+)");
pattern!(PAYEE, r"(?i)нов\p{L}*\s+(?:банковск\p{L}*\s+)?реквизит|смен\p{L}*\s+(?:банк|получател)|другой фирм|новый расч[её]тный сч[её]т");
pattern!(PREFIX, r"(?is)^.*?сч[её]т\s+№?\s*[\w/-]+\s*(?:за\s+)?");
pattern!(ORDER_DATE, format!(r"(?i)заказ[ау]?\s+от\s+({DATE})"));
pattern!(REPLACEMENT, r"(?i)исправленн\p{L}*\s+сч[её]т|в прошлой версии");
pattern!(RESEND, r"(?i)пересылаем повторно|дубликат|повторно присылаем");
pattern!(DELIVERY, format!(r"(?i)(?:привез[её]м|привез[её]т|отгрузим|поставим)\s+(?:до\s+|к\s+)?({DATE})"));
pattern!(BILL, r"(?i)^(?:(?:новый|исправленный)\s+)?сч[её]т\s");
pattern!(ISSUED, r"(?i)выставляем\s+сч[её]т");
pattern!(DATE_PARTS, r"^\s*([0-9]{1,2})\.([0-9]{1,2})(?:\.([0-9]{4}))?");
pattern!(SIZE, r"[0-9]+(?:\s*[хx×]\s*[0-9]+)+");
pattern!(MEASURE, r"(?:^|[^0-9×])([0-9]+(?:[.,][0-9]+)?)\s*(мкм|мм|кг|г|м)\b");
pattern!(PRICE_CHANGE, format!(r"(?i)({NUM})\s*(?:₽|руб)"));
pattern!(QUANTITY_CHANGE, r"(?i)количество\s+\p{L}+\s+с\s+[0-9]+\s+до\s+([0-9]+)");
pattern!(EFFECTIVE, format!(r"(?i)(?:поставок\s+с|вступает\s+в\s+силу\s+с)\s+({DATE})"));
pattern!(PRICE_START, r"(?i)^цена\s");

fn group<'a>(captures: Option<&Captures<'a>>, name: &str) -> &'a str {
    captures.and_then(|parts| parts.name(name)).map_or("", |part| part.as_str())
}

fn capture<'a>(regex: &Regex, value: &'a str) -> Option<&'a str> {
    regex.captures(value)?.get(1).map(|part| part.as_str())
}

pub fn number(value: &str) -> Option<f64> {
    let stripped: String = value.chars().filter(|character| !character.is_whitespace()).collect();
    if stripped.is_empty() {
        return None;
    }
    stripped.replace(',', ".").parse::<f64>().ok().filter(|value| value.is_finite())
}

pub fn clean(value: &str) -> String {
    value.to_lowercase().replace('ё', "е").replace(['"', '«', '»'], "").trim().to_string()
}

fn party(value: &str) -> String {
    clean(value.split(',').next().unwrap_or_default())
}

fn unit(value: &str) -> String {
    let value = clean(value);
    ["шт", "кг", "рул", "меш", "пач"].into_iter().find(|unit| value.starts_with(unit))
        .unwrap_or_default().to_string()
}

pub fn normalize_invoice(invoice: &str) -> &str {
    let leading = invoice.bytes().take_while(|&byte| byte == b'0').count();
    let strip = if invoice.as_bytes().get(leading).is_some_and(u8::is_ascii_digit) {
        leading
    } else {
        leading.saturating_sub(1)
    };
    &invoice[strip..]
}

fn order_id(value: &str) -> String {
    if let Some(id) = capture(&ORDER, value) {
        return format!("ЗП-{id}");
    }
    value.to_uppercase()
}

pub fn date_key(value: &str) -> Option<NaiveDate> {
    if let Some(parts) = DATE_PARTS.captures(value) {
        let day = parts[1].parse().ok()?;
        let month = parts[2].parse().ok()?;
        let year = parts.get(3).map_or(Some(2026), |year| year.as_str().parse().ok())?;
        return NaiveDate::from_ymd_opt(year, month, day);
    }
    let serial = number(value)?;
    if !(0.0..=3_000_000.0).contains(&serial) {
        return None;
    }
    NaiveDate::from_ymd_opt(1899, 12, 30)?.checked_add_days(Days::new(serial.floor() as u64))
}

#[derive(Debug, Default, Clone)]
pub struct Material {
    dimensions: Vec<String>,
    measures: BTreeMap<&'static str, Vec<f64>>,
}

impl Material {
    fn read(text: &str) -> Self {
        let text = clean(text);
        let dimensions = SIZE.find_iter(&text).map(|size| {
            let compact: String = size.as_str().chars().filter(|c| !c.is_whitespace()).collect();
            compact.replace(['х', 'x'], "×")
        }).collect();
        let mut measures: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
        for item in MEASURE.captures_iter(&text) {
            if let Some(count) = number(&item[1]) {
                let (group, value) = match &item[2] {
                    "кг" => ("масса", count * 1000.0),
                    "г" => ("масса", count),
                    "мм" => ("мм", count),
                    "мкм" => ("мкм", count),
                    _ => ("м", count),
                };
                measures.entry(group).or_default().push(value);
            }
        }
        Self { dimensions, measures }
    }

    pub fn conflicts(&self, other: &Self) -> bool {
        if !self.dimensions.is_empty() && !other.dimensions.is_empty()
            && !self.dimensions.iter().any(|size| other.dimensions.contains(size)) {
            return true;
        }
        self.measures.iter().any(|(group, values)| other.measures.get(group)
            .is_some_and(|right| !values.iter().any(|value| right.contains(value))))
    }

    pub fn has_shared_spec(&self, other: &Self) -> bool {
        self.dimensions.iter().any(|size| other.dimensions.contains(size))
            || self.measures.iter().any(|(group, values)| other.measures.get(group)
                .is_some_and(|right| values.iter().any(|value| right.contains(value))))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub row: usize,
    pub received: String,
    pub sender: String,
    pub text: String,
    pub invoice: String,
    pub amount: Option<f64>,
    pub stated_order: String,
    pub looks_like_bill: bool,
    pub manual: bool,
    #[serde(skip)] pub party: String,
    #[serde(skip)] pub material_text: String,
    #[serde(skip)] pub material: Material,
    #[serde(skip)] pub order_date: Option<NaiveDate>,
    #[serde(skip)] pub replacement: bool,
    #[serde(skip)] pub resend: bool,
    #[serde(skip)] pub changes_payee: bool,
    #[serde(skip)] pub delivery: Option<String>,
    #[serde(skip)] pub raw_quantity: Option<f64>,
    #[serde(skip)] pub raw_price: Option<f64>,
    #[serde(skip)] pub package_size: Option<f64>,
    #[serde(skip)] pub raw_unit: String,
    #[serde(skip)] pub pack_unit: String,
}

impl Message {
    pub fn new(id: String, row: usize, received: String, sender: String, text: String, manual: bool) -> Self {
        let charge = CHARGE.captures(&text);
        let quantity = charge.or_else(|| QUANTITY.captures(&text));
        let prefix = quantity.as_ref().and_then(|parts| parts.get(0)).map_or("", |part| &text[..part.start()]);
        let material_text = PREFIX.replace(prefix.split_once(':').map_or(prefix, |(_, rest)| rest), "")
            .trim().trim_end_matches(',').trim().to_string();
        let invoice = capture(&INVOICE, &text).unwrap_or_default().to_string();
        let raw_price = number(group(quantity.as_ref(), "price"));
        let resend = RESEND.is_match(&text);
        let looks_like_bill = BILL.is_match(&text) || (!invoice.is_empty() && (raw_price.is_some() || resend || ISSUED.is_match(&text)));
        let stated_order = capture(&ORDER, &text).map_or_else(String::new, |id| format!("ЗП-{id}"));
        let raw_quantity = number(group(quantity.as_ref(), "qty"));
        let package_size = number(group(quantity.as_ref(), "pack"));
        let raw_unit = unit(group(quantity.as_ref(), "unit"));
        let pack_unit = unit(group(quantity.as_ref(), "pack_unit"));
        Self {
            id, row, received, manual, party: party(&sender), sender, invoice, stated_order,
            amount: capture(&AMOUNT, &text).and_then(number),
            order_date: capture(&ORDER_DATE, &text).and_then(date_key),
            replacement: REPLACEMENT.is_match(&text), resend,
            changes_payee: PAYEE.is_match(&text),
            delivery: capture(&DELIVERY, &text).map(str::to_string),
            looks_like_bill, raw_quantity, raw_price, package_size, raw_unit, pack_unit,
            material: Material::read(&material_text), material_text, text,
        }
    }

    pub fn units_for(&self, order: &Order) -> Option<(f64, f64)> {
        let quantity = self.raw_quantity?;
        let price = self.raw_price.unwrap_or(0.0);
        if self.raw_unit == order.unit && self.package_size.unwrap_or(0.0) == 0.0 {
            return Some((quantity, price));
        }
        if self.pack_unit == order.unit {
            if let Some(size) = self.package_size.filter(|size| *size > 0.0) {
                return Some((quantity * size, price / size));
            }
        }
        None
    }
}

#[derive(Serialize)]
pub struct Order {
    pub id: String,
    pub row: usize,
    pub supplier: String,
    pub material: String,
    pub unit: String,
    pub ordered: Option<f64>,
    pub received: Option<f64>,
    #[serde(skip)] pub buyer: String,
    #[serde(skip)] pub date: Option<NaiveDate>,
    #[serde(skip)] pub receipt_date: Option<NaiveDate>,
    #[serde(skip)] pub price: Option<f64>,
    #[serde(skip)] pub party: String,
    #[serde(skip)] pub specs: Material,
}

#[derive(Serialize)]
pub struct Change {
    pub id: String,
    pub text: String,
    pub status: String,
    pub row: usize,
    #[serde(skip)] pub order: String,
    #[serde(skip)] pub signed: bool,
}

#[derive(Clone, Serialize)]
pub struct Rule {
    pub title: String,
    pub text: String,
}

#[derive(Serialize)]
pub struct Terms {
    pub price: Option<f64>,
    pub ordered: Option<f64>,
    pub uncertain: bool,
    pub notes: Vec<String>,
}

impl Terms {
    pub fn new(order: &Order, changes: &[Arc<Change>]) -> Self {
        let mut terms = Self { price: order.price, ordered: order.ordered, uncertain: false, notes: Vec::new() };
        for change in changes {
            if !change.signed {
                terms.notes.push(format!("{} · {}", change.id, change.status));
                continue;
            }
            if let Some(starts) = capture(&EFFECTIVE, &change.text) {
                if order.receipt_date.is_none() || order.receipt_date >= date_key(starts) {
                    terms.uncertain = true;
                    terms.notes.push(format!("{} · нужно подтвердить дату партии для цены с {starts}", change.id));
                } else {
                    terms.notes.push(format!("{} · действует с {starts}, после приёмки", change.id));
                }
                continue;
            }
            if let Some(quantity) = capture(&QUANTITY_CHANGE, &change.text).and_then(number) {
                terms.ordered = Some(quantity);
            }
            if PRICE_START.is_match(&change.text) {
                if let Some(price) = capture(&PRICE_CHANGE, &change.text).and_then(number) {
                    terms.price = Some(price);
                }
            }
            terms.notes.push(format!("{} · подписано", change.id));
        }
        terms
    }
}

pub struct Book {
    pub messages: Vec<Message>,
    pub orders: BTreeMap<String, Arc<Order>>,
    pub changes: Vec<Arc<Change>>,
    pub rules: BTreeMap<String, Rule>,
    pub mail_rows: usize,
}

fn cell(row: &[Data], column: usize) -> String {
    match row.get(column).unwrap_or(&Data::Empty) {
        Data::Empty | Data::Error(_) => String::new(),
        Data::DateTime(value) => value.as_f64().to_string(),
        value => value.to_string(),
    }
}

fn validate_archive(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_FILE {
        return Err("Размер XLSX превышает 64 МБ.".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "Файл не похож на книгу XLSX.".to_string())?;
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|_| "Не удалось прочитать структуру XLSX.")?;
        total = total.saturating_add(entry.size());
        if total > MAX_XML {
            return Err("Распакованные данные XLSX превышают 256 МБ.".into());
        }
    }
    Ok(())
}

impl Book {
    pub fn read(bytes: &[u8]) -> Result<Self, String> {
        validate_archive(bytes)?;
        let mut xlsx: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
            .map_err(|error| format!("Не удалось прочитать книгу Excel. {error}"))?;
        let mut book = Self { messages: Vec::new(), orders: BTreeMap::new(), changes: Vec::new(),
            rules: BTreeMap::new(), mail_rows: 0 };
        for (sheet, name) in SHEETS.into_iter().enumerate() {
            let range = xlsx.worksheet_range(name)
                .map_err(|error| format!("Не удалось прочитать лист «{name}». {error}"))?;
            let (start, start_col) = range.start().ok_or_else(|| format!("Лист «{name}» пуст."))?;
            let (end, end_col) = range.end().unwrap();
            if end >= MAX_ROWS || end_col >= 64 {
                return Err(format!("Лист «{name}» превышает предел в 250 000 записей или 64 столбца."));
            }
            if start_col != 0 || end < 2 {
                return Err(format!("Проверьте расположение заголовков на листе «{name}»."));
            }
            if sheet == 0 {
                book.mail_rows = (end + 1) as usize;
            }
            for (index, row) in range.rows().enumerate() {
                let position = start as usize + index + 1;
                if position <= 3 { continue; }
                let id = cell(row, 0);
                if id.is_empty() { continue; }
                match sheet {
                    0 => {
                        let text = cell(row, 3);
                        if !text.is_empty() {
                            book.messages.push(Message::new(id, position, cell(row, 1), cell(row, 2), text, false));
                        }
                    }
                    1 => {
                        let id = order_id(&id);
                        let supplier = cell(row, 2);
                        let material = cell(row, 4);
                        let order = Arc::new(Order {
                            id: id.clone(), row: position, party: party(&supplier), supplier,
                            specs: Material::read(&material), material, unit: unit(&cell(row, 5)),
                            ordered: number(&cell(row, 6)), received: number(&cell(row, 7)),
                            price: number(&cell(row, 9)), buyer: cell(row, 3),
                            date: date_key(&cell(row, 1)), receipt_date: date_key(&cell(row, 8)),
                        });
                        book.orders.insert(id, order);
                    }
                    2 => {
                        let status = cell(row, 4);
                        book.changes.push(Arc::new(Change {
                            id, row: position, order: order_id(&cell(row, 2)), text: cell(row, 3),
                            signed: clean(&status) == "подписано" && !cell(row, 5).is_empty(), status,
                        }));
                    }
                    _ => { book.rules.insert(id, Rule { title: cell(row, 1), text: cell(row, 2) }); }
                }
            }
        }
        if book.messages.is_empty() {
            return Err("В листе «Счета и письма» нет писем для сверки.".into());
        }
        Ok(book)
    }
}
