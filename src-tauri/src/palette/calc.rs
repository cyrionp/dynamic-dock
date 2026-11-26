//! The launcher's calculator: "12*(3+4)", "2^10", "sqrt(2)", "200*15%",
//! "3,5 + 1,25" (a comma works as the decimal point, as in Turkish).
//!
//! A small recursive-descent parser over f64, no dependencies. It only
//! answers when the text really looks like arithmetic, so typing an app
//! name never shows a calculator row.

/// The value of `text`, or `None` when it isn't a sum (or has no finite
/// answer). A leading "=" forces a try.
pub fn evaluate(text: &str) -> Option<f64> {
    let forced = text.trim_start().starts_with('=');
    let body = text.trim().trim_start_matches('=').trim();
    if body.is_empty() || (!forced && !looks_like_math(body)) {
        return None;
    }
    let tokens = tokenize(body)?;
    let mut p = Parser { tokens, pos: 0 };
    let v = p.expr()?;
    if p.pos != p.tokens.len() || !v.is_finite() {
        return None;
    }
    Some(v)
}

/// The answer as text: up to 10 decimals, no trailing zeros, no "-0".
pub fn format(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    if v.abs() >= 1e15 || v.abs() < 1e-9 {
        return format!("{v:e}");
    }
    let s = format!("{v:.10}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

/// A digit and an operator or a function: "2+2", "sqrt 9", "(5)". A lone
/// number ("2024") or a version ("1.2.3") is not a sum.
fn looks_like_math(s: &str) -> bool {
    let has_digit = s.chars().any(|c| c.is_ascii_digit());
    let has_const = s.split(|c: char| !c.is_alphabetic()).any(|w| w == "pi");
    if !has_digit && !has_const {
        return false;
    }
    let has_op = s.chars().skip(1).any(|c| matches!(c, '+' | '-' | '*' | '/' | '^' | '%' | 'x' | '×' | '÷' | '(' ));
    let has_fn = FUNCS.iter().any(|f| s.contains(f));
    has_op || has_fn || s.starts_with('(') || s.starts_with('-') && s.len() > 1 && s[1..].contains(|c: char| !c.is_ascii_digit() && c != '.' && c != ',')
}

const FUNCS: [&str; 13] = ["sqrt", "sin", "cos", "tan", "log", "ln", "abs", "round", "floor", "ceil", "exp", "mod", "pi"];

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Op(char),
    Open,
    Close,
    Ident(String),
}

fn tokenize(s: &str) -> Option<Vec<Tok>> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() || c == '_' || c == '\'' {
            i += 1;
        } else if c.is_ascii_digit() || ((c == '.' || c == ',') && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let start = i;
            let mut seen_point = false;
            while i < chars.len() {
                let d = chars[i];
                if d.is_ascii_digit() {
                    i += 1;
                } else if (d == '.' || d == ',') && !seen_point && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit()) {
                    seen_point = true;
                    i += 1;
                } else {
                    break;
                }
            }
            let text: String = chars[start..i].iter().map(|&d| if d == ',' { '.' } else { d }).collect();
            out.push(Tok::Num(text.parse().ok()?));
        } else if c.is_alphabetic() && c != 'x' && c != '×' {
            let start = i;
            while i < chars.len() && chars[i].is_alphabetic() {
                i += 1;
            }
            out.push(Tok::Ident(chars[start..i].iter().collect::<String>().to_lowercase()));
        } else {
            out.push(match c {
                '+' | '-' | '/' | '^' | '%' => Tok::Op(c),
                '*' | 'x' | '×' => Tok::Op('*'),
                '÷' => Tok::Op('/'),
                '(' => Tok::Open,
                ')' => Tok::Close,
                _ => return None,
            });
            i += 1;
        }
    }
    Some(out)
}

struct Parser {
    tokens: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos)
    }

    fn eat_op(&mut self, ops: &[char]) -> Option<char> {
        if let Some(Tok::Op(c)) = self.peek() {
            if ops.contains(c) {
                let c = *c;
                self.pos += 1;
                return Some(c);
            }
        }
        None
    }

    // expr := term (('+'|'-') term)*
    fn expr(&mut self) -> Option<f64> {
        let mut v = self.term()?;
        while let Some(op) = self.eat_op(&['+', '-']) {
            let rhs = self.term()?;
            v = if op == '+' { v + rhs } else { v - rhs };
        }
        Some(v)
    }

    // term := unary (('*'|'/'|mod) unary | implicit unary)*
    fn term(&mut self) -> Option<f64> {
        let mut v = self.unary()?;
        loop {
            if let Some(op) = self.eat_op(&['*', '/']) {
                let rhs = self.unary()?;
                v = if op == '*' { v * rhs } else { v / rhs };
            } else if matches!(self.peek(), Some(Tok::Ident(w)) if w == "mod") {
                self.pos += 1;
                let rhs = self.unary()?;
                v %= rhs;
            } else if matches!(self.peek(), Some(Tok::Open) | Some(Tok::Ident(_))) {
                // "2(3+4)", "2pi"
                let rhs = self.unary()?;
                v *= rhs;
            } else {
                return Some(v);
            }
        }
    }

    fn unary(&mut self) -> Option<f64> {
        if self.eat_op(&['-']).is_some() {
            return Some(-self.unary()?);
        }
        if self.eat_op(&['+']).is_some() {
            return self.unary();
        }
        self.power()
    }

    // power := postfix ('^' unary)?   (right-associative)
    fn power(&mut self) -> Option<f64> {
        let base = self.postfix()?;
        if self.eat_op(&['^']).is_some() {
            let exp = self.unary()?;
            return Some(base.powf(exp));
        }
        Some(base)
    }

    // A "%" right after a number is a percentage: "200*15%" is 30.
    fn postfix(&mut self) -> Option<f64> {
        let mut v = self.primary()?;
        while self.eat_op(&['%']).is_some() {
            v /= 100.0;
        }
        Some(v)
    }

    fn primary(&mut self) -> Option<f64> {
        match self.tokens.get(self.pos).cloned()? {
            Tok::Num(n) => {
                self.pos += 1;
                Some(n)
            }
            Tok::Open => {
                self.pos += 1;
                let v = self.expr()?;
                // A missing ")" at the very end is forgiven while typing.
                if self.peek() == Some(&Tok::Close) {
                    self.pos += 1;
                } else if self.peek().is_some() {
                    return None;
                }
                Some(v)
            }
            Tok::Ident(name) => {
                self.pos += 1;
                match name.as_str() {
                    "pi" | "π" => return Some(std::f64::consts::PI),
                    "e" => return Some(std::f64::consts::E),
                    _ => {}
                }
                let arg = self.unary()?;
                Some(match name.as_str() {
                    "sqrt" => arg.sqrt(),
                    "sin" => arg.to_radians().sin(),
                    "cos" => arg.to_radians().cos(),
                    "tan" => arg.to_radians().tan(),
                    "log" => arg.log10(),
                    "ln" => arg.ln(),
                    "abs" => arg.abs(),
                    "round" => arg.round(),
                    "floor" => arg.floor(),
                    "ceil" => arg.ceil(),
                    "exp" => arg.exp(),
                    _ => return None,
                })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str) -> Option<String> {
        evaluate(s).map(format)
    }

    #[test]
    fn arithmetic() {
        assert_eq!(ev("12*(3+4)").as_deref(), Some("84"));
        assert_eq!(ev("2^10").as_deref(), Some("1024"));
        assert_eq!(ev("2^3^2").as_deref(), Some("512"));
        assert_eq!(ev("-2^2").as_deref(), Some("-4"));
        assert_eq!(ev("10/4").as_deref(), Some("2.5"));
        assert_eq!(ev("3,5 + 1,25").as_deref(), Some("4.75"));
        assert_eq!(ev("200*15%").as_deref(), Some("30"));
        assert_eq!(ev("7 mod 3").as_deref(), Some("1"));
        assert_eq!(ev("2(3+4)").as_deref(), Some("14"));
        assert_eq!(ev("sqrt(16)+1").as_deref(), Some("5"));
        assert_eq!(ev("6 x 7").as_deref(), Some("42"));
        assert_eq!(ev("(1+2").as_deref(), Some("3"));
        assert_eq!(ev("0.1+0.2").as_deref(), Some("0.3"));
    }

    #[test]
    fn not_math() {
        assert_eq!(ev("chrome"), None);
        assert_eq!(ev("2024"), None);
        assert_eq!(ev("1.2.3"), None);
        assert_eq!(ev("1/0"), None);
        assert_eq!(ev("2+"), None);
        assert_eq!(ev("win+r"), None);
        assert_eq!(ev("=2024").as_deref(), Some("2024"));
    }
}
