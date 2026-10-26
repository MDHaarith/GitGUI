use super::*;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    #[serde(default)]
    pub signoff: bool,
    pub author: Option<String>,
}

impl CommitOptions {
    pub(super) fn args(&self) -> Result<Vec<OsString>> {
        let mut args = Vec::new();
        if self.signoff {
            args.push(os("--signoff"));
        }
        if let Some(author) = &self.author {
            let (name, email) = author
                .rsplit_once(" <")
                .ok_or("Enter the author as Name <email>.")?;
            let email = email
                .strip_suffix('>')
                .ok_or("Enter the author as Name <email>.")?;
            let (local, domain) = email
                .split_once('@')
                .ok_or("Enter an author email address.")?;
            if author.len() > 512
                || author.chars().any(char::is_control)
                || name.trim().is_empty()
                || name.contains(['<', '>'])
                || local.is_empty()
                || domain.is_empty()
                || email.matches('@').count() != 1
                || email.chars().any(char::is_whitespace)
                || email.contains(['<', '>'])
            {
                return Err("Enter the author as Name <email>, without control characters.".into());
            }
            args.extend([os("--author"), os(author)]);
        }
        Ok(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn author_requires_an_explicit_identity() {
        for author in [
            "Alice",
            "--reset-author",
            "A <a>",
            "A <a@>",
            "A <@b>",
            "A <a@@b>",
            "A <a b@c>",
            "A\nB <a@b>",
            " <a@b>",
            "A <a@b> extra",
        ] {
            assert!(
                CommitOptions {
                    signoff: false,
                    author: Some(author.into())
                }
                .args()
                .is_err(),
                "{author}"
            );
        }
        assert_eq!(
            CommitOptions {
                signoff: true,
                author: Some("Álice Example <alice@example.invalid>".into())
            }
            .args()
            .unwrap(),
            argv(&[
                "--signoff",
                "--author",
                "Álice Example <alice@example.invalid>"
            ])
        );
    }
}
