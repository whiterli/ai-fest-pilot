mod model;
mod reconcile;
mod report;

use base64::{engine::general_purpose::STANDARD, Engine};
use model::{Book, Message, MAX_FILE};
use reconcile::{reconcile, Dataset};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::{self, BufRead, BufWriter, Write}, path::Path};

#[derive(Deserialize)]
struct Request {
    id: u64,
    #[serde(flatten)]
    command: Command,
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "lowercase")]
enum Command {
    Load { name: String, xlsx: String },
    Append { sender: String, body: String },
    Export,
}

#[derive(Serialize)]
struct Response<T> {
    core: bool,
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct Analysis<'a> {
    dataset: &'a Dataset,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected: Option<String>,
}

struct Session {
    source: String,
    book: Book,
    added: Vec<Message>,
    dataset: Dataset,
}

fn respond<T: Serialize>(output: &mut impl Write, id: u64, result: Result<T, String>) -> io::Result<()> {
    let (data, error) = match result {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    serde_json::to_writer(&mut *output, &Response { core: true, id, data, error })?;
    output.write_all(b"\n")?;
    output.flush()
}

fn load(name: String, xlsx: &str) -> Result<Session, String> {
    if xlsx.len() > MAX_FILE.div_ceil(3) * 4 {
        return Err("Размер XLSX превышает 64 МБ.".into());
    }
    let bytes = STANDARD.decode(xlsx).map_err(|_| "Не удалось получить данные файла.")?;
    let book = Book::read(&bytes)?;
    let dataset = reconcile(&book, &[]);
    Ok(Session { source: name, book, added: Vec::new(), dataset })
}

impl Session {
    fn append(&mut self, sender: String, body: String) -> Result<Analysis<'_>, String> {
        if sender.trim().is_empty() || body.trim().is_empty() || sender.chars().count() > 160 || body.chars().count() > 12_000 {
            return Err("Проверьте отправителя и текст письма.".into());
        }
        let mut index = self.added.len() + 1;
        let selected = loop {
            let candidate = format!("Н-{index}");
            if !self.dataset.entries.iter().any(|entry| entry.message.id == candidate) {
                break candidate;
            }
            index += 1;
        };
        let row = self.book.mail_rows + self.added.len() + 1;
        self.added.push(Message::new(selected.clone(), row, "Новое письмо".into(), sender, body, true));
        self.dataset = reconcile(&self.book, &self.added);
        Ok(Analysis { dataset: &self.dataset, selected: Some(selected) })
    }
}

fn serve() -> io::Result<()> {
    let input = io::stdin().lock();
    let mut output = BufWriter::new(io::stdout().lock());
    let mut session = None;
    for line in input.lines() {
        let line = line?;
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(_) => {
                let id = serde_json::from_str::<Value>(&line).ok().and_then(|value| value["id"].as_u64()).unwrap_or(0);
                respond::<()>(&mut output, id, Err("Не удалось прочитать запрос к модулю сверки.".into()))?;
                continue;
            }
        };
        let id = request.id;
        match request.command {
            Command::Load { name, xlsx } => match load(name, &xlsx) {
                Ok(next) => {
                    let current = session.insert(next);
                    respond(&mut output, id, Ok(Analysis { dataset: &current.dataset, selected: None }))?;
                }
                Err(error) => respond::<()>(&mut output, id, Err(error))?,
            },
            Command::Append { sender, body } => {
                let result = session.as_mut().ok_or_else(|| "Сначала загрузите книгу XLSX.".to_string())
                    .and_then(|current| current.append(sender, body));
                respond(&mut output, id, result)?;
            }
            Command::Export => {
                let result = session.as_ref().ok_or_else(|| "Сначала загрузите книгу XLSX.".to_string())
                    .and_then(|current| report::export(&current.dataset, &current.source).map_err(|error| error.to_string()))
                    .map(|bytes| STANDARD.encode(bytes));
                respond(&mut output, id, result)?;
            }
        }
    }
    Ok(())
}

fn analyze_file(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(path)?;
    let book = Book::read(&bytes)?;
    serde_json::to_writer(BufWriter::new(io::stdout().lock()), &reconcile(&book, &[]))?;
    Ok(())
}

fn main() {
    let result: Result<(), Box<dyn std::error::Error>> = match std::env::args_os().nth(1) {
        Some(path) => analyze_file(Path::new(&path)),
        None => serve().map_err(Into::into),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
