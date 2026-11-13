use crate::reconcile::{Dataset, Status};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook, XlsxError};

pub fn export(dataset: &Dataset, source: &str) -> Result<Vec<u8>, XlsxError> {
    let mut workbook = Workbook::new();
    let header = Format::new().set_bold().set_font_color(Color::White)
        .set_background_color(Color::RGB(0x005c66)).set_text_wrap().set_align(FormatAlign::VerticalCenter);
    let wrap = Format::new().set_text_wrap().set_align(FormatAlign::Top);
    let money = Format::new().set_num_format("#,##0.00");
    let entries = &dataset.entries;
    let ready = entries.iter().filter(|entry| entry.result.status == Status::Ready).count();
    let attention = entries.iter().filter(|entry| entry.result.status.requires_action()).count();
    let sheet = workbook.add_worksheet().set_name("Сводка")?;
    sheet.set_column_width(0, 29)?.set_column_width(1, 48)?;
    sheet.set_freeze_panes(1, 0)?;
    sheet.set_row_height(0, 25)?;
    sheet.write_string_with_format(0, 0, "Показатель", &header)?;
    sheet.write_string_with_format(0, 1, "Значение", &header)?;
    for (index, (label, count)) in [
        ("Всего писем", entries.len()), ("Требуют действия", attention),
        ("Сверены", ready), ("Переписка и повторы", entries.len() - attention - ready),
    ].into_iter().enumerate() {
        sheet.write_string(index as u32 + 1, 0, label)?;
        sheet.write_number(index as u32 + 1, 1, count as f64)?;
    }
    sheet.write_string(5, 0, "Исходная книга")?;
    sheet.write_string_with_format(5, 1, source, &wrap)?;

    let sheet = workbook.add_worksheet().set_name("Результаты")?;
    let headings = ["Письмо", "Получено", "Поставщик", "Счёт", "Заказ", "Статус", "Сумма, ₽",
        "Расхождение, ₽", "Причина", "Следующий шаг", "Кому", "Связанное письмо", "Правила"];
    let widths = [14, 18, 27, 13, 13, 25, 17, 20, 58, 58, 32, 22, 24];
    sheet.set_freeze_panes(1, 0)?;
    sheet.set_row_height(0, 25)?;
    for (column, (label, width)) in headings.iter().zip(widths).enumerate() {
        sheet.set_column_width(column as u16, width as u16)?;
        sheet.write_string_with_format(0, column as u16, *label, &header)?;
    }
    for (index, entry) in entries.iter().enumerate() {
        let row = index as u32 + 1;
        let msg = &entry.message;
        let result = &entry.result;
        let rules = result.rules.join(", ");
        let columns = [
            (0, msg.id.as_str()), (1, &msg.received), (2, &msg.sender), (3, &msg.invoice),
            (4, entry.order.as_ref().map_or(&msg.stated_order, |order| &order.id)),
            (5, result.status.label()), (8, &result.explanation), (9, result.action),
            (10, &result.recipient), (11, entry.related.as_deref().unwrap_or("")), (12, &rules),
        ];
        let mut lines = 1;
        for (column, value) in columns {
            if !value.is_empty() {
                let width = widths[column as usize] - 3;
                lines = lines.max(value.lines().map(|line| line.chars().count().div_ceil(width).max(1)).sum());
                let text: String = value.chars().take(32_767).collect();
                sheet.write_string_with_format(row, column, text, &wrap)?;
            }
        }
        sheet.set_row_height(row, (lines * 15 + 5).clamp(20, 108) as u16)?;
        if let Some(amount) = msg.amount {
            sheet.write_number_with_format(row, 6, amount, &money)?;
        }
        if let Some(delta) = result.delta {
            sheet.write_number_with_format(row, 7, delta, &money)?;
        }
    }
    sheet.autofilter(0, 0, entries.len() as u32, headings.len() as u16 - 1)?;
    workbook.save_to_buffer()
}
