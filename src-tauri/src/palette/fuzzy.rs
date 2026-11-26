//! Fuzzy matching for the launcher: "vsc" finds "Visual Studio Code",
//! "ayar" finds "Ayarlar", "ss" finds "Snipping Tool"'s neighbour
//! "Screen Sketch". Plain Rust, no allocations per candidate beyond the
//! folded query, so tens of thousands of entries score in a few
//! milliseconds.
//!
//! Text is folded first: lower case, Turkish and other Latin accents
//! dropped (ı/İ→i, ş→s, ğ→g, ü→u, ö→o, ç→c, é→e…), so "sistem" matches
//! "Sıstem" and "cop" matches "Çöp Kutusu".

/// Lower case without accents. One output char per input char, so
/// positions line up with the original text.
pub fn fold(text: &str) -> String {
    text.chars().map(fold_char).collect()
}

pub fn fold_char(c: char) -> char {
    match c {
        'ı' | 'İ' | 'I' | 'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
        'ş' | 'Ş' | 'ś' | 'Ś' | 'š' | 'Š' => 's',
        'ğ' | 'Ğ' => 'g',
        'ü' | 'Ü' | 'ú' | 'ù' | 'û' | 'Ú' | 'Ù' | 'Û' => 'u',
        'ö' | 'Ö' | 'ó' | 'ò' | 'ô' | 'õ' | 'Ó' | 'Ò' | 'Ô' | 'Õ' | 'ø' | 'Ø' => 'o',
        'ç' | 'Ç' | 'ć' | 'Ć' | 'č' | 'Č' => 'c',
        'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
        'ñ' | 'Ñ' => 'n',
        'ž' | 'Ž' | 'ź' | 'Ź' | 'ż' | 'Ż' => 'z',
        c if c.is_ascii() => c.to_ascii_lowercase(),
        c => c.to_lowercase().next().unwrap_or(c),
    }
}

fn is_boundary(prev: Option<char>, c: char) -> bool {
    match prev {
        None => true,
        Some(p) => !p.is_alphanumeric() || (p.is_lowercase() && c.is_uppercase()) || (p.is_alphabetic() && c.is_numeric()),
    }
}

/// Scores `query` (already folded, trimmed, not empty) against `text`
/// (`folded` is `fold(text)`). Higher is better; `None` when it doesn't
/// match at all.
///
/// Whole text > start of the text > start of a word > anywhere inside >
/// the letters in order (initials score more than scattered letters).
pub fn score(query: &str, text: &str, folded: &str) -> Option<i32> {
    if query.is_empty() || folded.is_empty() {
        return None;
    }
    let qlen = query.chars().count() as i32;
    let tlen = folded.chars().count() as i32;
    if folded == query {
        return Some(1000);
    }
    if folded.starts_with(query) {
        return Some(900 - (tlen - qlen).min(100));
    }
    if let Some(pos) = word_start(folded, query) {
        return Some(760 - pos.min(60) as i32 - (tlen - qlen).min(60));
    }
    if let Some(pos) = folded.find(query) {
        return Some(520 - (pos as i32).min(120));
    }
    // Several words: each one must be found somewhere ("code studio").
    if query.contains(' ') {
        let mut total = 0;
        let mut n = 0;
        for word in query.split_whitespace() {
            if let Some(pos) = word_start(folded, word) {
                total += 60 - pos.min(40) as i32;
            } else if folded.contains(word) {
                total += 10;
            } else {
                return None;
            }
            n += 1;
        }
        return Some(420 + total / n.max(1));
    }
    subsequence(query, text, folded).map(|s| s.min(500))
}

/// Where a word of `folded` starts with `query` (byte offset).
pub fn word_start(folded: &str, query: &str) -> Option<usize> {
    let mut prev: Option<char> = None;
    for (i, c) in folded.char_indices() {
        if prev.map_or(true, |p| !p.is_alphanumeric()) && folded[i..].starts_with(query) {
            return Some(i);
        }
        prev = Some(c);
    }
    None
}

/// The query's letters appear in order. Letters at word starts and in runs
/// score more; gaps cost.
fn subsequence(query: &str, text: &str, folded: &str) -> Option<i32> {
    let original: Vec<char> = text.chars().collect();
    let folded: Vec<char> = folded.chars().collect();
    if let Some(s) = initials(query, &original, &folded) {
        return Some(s);
    }
    let mut qi = query.chars().peekable();
    let mut score = 0i32;
    let mut last: Option<usize> = None;
    let mut first: Option<usize> = None;
    for (i, &c) in folded.iter().enumerate() {
        let Some(&want) = qi.peek() else { break };
        if c != want {
            continue;
        }
        let prev = if i == 0 { None } else { original.get(i - 1).copied() };
        let at_boundary = is_boundary(prev, original.get(i).copied().unwrap_or(c));
        if at_boundary {
            score += 30;
        }
        match last {
            Some(l) if l + 1 == i => score += 18,
            Some(l) => score -= ((i - l - 1) as i32).min(12),
            None => {}
        }
        first.get_or_insert(i);
        last = Some(i);
        qi.next();
    }
    if qi.peek().is_some() {
        return None;
    }
    score -= (first.unwrap_or(0) as i32).min(20);
    Some(200 + score.min(250))
}

/// Every letter of the query starts a word, in order: "vsc" in "Visual
/// Studio Code", "ps" in "PowerShell". Reads like an abbreviation.
fn initials(query: &str, original: &[char], folded: &[char]) -> Option<i32> {
    let q: Vec<char> = query.chars().collect();
    if q.len() < 2 {
        return None;
    }
    let mut qi = 0;
    let mut first = None;
    for (i, &c) in folded.iter().enumerate() {
        if qi == q.len() {
            break;
        }
        let prev = if i == 0 { None } else { original.get(i - 1).copied() };
        if c == q[qi] && is_boundary(prev, original.get(i).copied().unwrap_or(c)) {
            first.get_or_insert(i);
            qi += 1;
        }
    }
    (qi == q.len()).then(|| 460 - (first.unwrap_or(0) as i32).min(20))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(q: &str, t: &str) -> Option<i32> {
        score(&fold(q), t, &fold(t))
    }

    #[test]
    fn folds_turkish() {
        assert_eq!(fold("Çöp Kutusu"), "cop kutusu");
        assert_eq!(fold("İŞĞÜÖÇı"), "isguoci");
    }

    #[test]
    fn order_of_kinds() {
        let exact = s("code", "Code").unwrap();
        let prefix = s("vis", "Visual Studio Code").unwrap();
        let word = s("stu", "Visual Studio Code").unwrap();
        let inside = s("sual", "Visual Studio Code").unwrap();
        let initials = s("vsc", "Visual Studio Code").unwrap();
        let scattered = s("vlc", "Visual Studio Code").unwrap();
        assert!(exact > prefix && prefix > word && word > inside, "{exact} {prefix} {word} {inside}");
        assert!(initials > scattered, "{initials} {scattered}");
        assert!(s("xyz", "Visual Studio Code").is_none());
    }

    #[test]
    fn turkish_queries() {
        assert!(s("cop", "Çöp Kutusu").is_some());
        assert!(s("ayar", "Ayarlar").is_some());
        assert!(s("sistem", "Sıstem").is_some());
    }

    #[test]
    fn many_words() {
        assert!(s("code studio", "Visual Studio Code").is_some());
        assert!(s("code paint", "Visual Studio Code").is_none());
    }

    #[test]
    fn camel_case_initials() {
        assert!(s("ps", "PowerShell").unwrap() > s("ps", "Pictures").unwrap_or(0));
    }
}
