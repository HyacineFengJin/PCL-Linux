//! One rule evaluator for library admission and launch arguments. Native
//! classifiers constrain metadata further, so missing arch rules cannot cause
//! an incompatible binary to enter the download set or launch classpath.
use crate::{
    platform::{self, Architecture, Platform},
    text, Result,
};
use regex::Regex;
use serde_json::Value;

pub(crate) struct RuleContext {
    pub platform: Platform,
    pub release: String,
    pub custom_resolution: bool,
}
impl RuleContext {
    pub fn current() -> Result<Self> {
        Ok(Self {
            platform: Platform::current()?,
            release: platform::os_version(),
            custom_resolution: false,
        })
    }
    fn matches(&self, rule: &Value) -> Result<bool> {
        let os = &rule["os"];
        if os["name"]
            .as_str()
            .is_some_and(|name| name != self.platform.os.minecraft_name())
        {
            return Ok(false);
        }
        if let Some(pattern) = os["arch"].as_str() {
            // Architecture patterns describe an entire architecture. In
            // particular, "x86" must not match the prefix of "x86_64".
            let regex = Regex::new(&format!("^(?:{pattern})$"))
                .map_err(|e| format!("Invalid OS rule regex: {e}"))?;
            if Architecture::parse(pattern) != Some(self.platform.arch)
                && !regex.is_match(self.platform.arch.name())
            {
                return Ok(false);
            }
        }
        if let Some(pattern) = os["version"].as_str() {
            let regex = Regex::new(pattern).map_err(|e| format!("Invalid OS rule regex: {e}"))?;
            if self.release.is_empty() || !regex.is_match(&self.release) {
                return Ok(false);
            }
        }
        // Demo and quick-play remain false in both online and offline modes.
        Ok(!rule["features"]
            .as_object()
            .into_iter()
            .flatten()
            .any(|(name, v)| {
                let actual = name == "has_custom_resolution" && self.custom_resolution;
                v.as_bool().is_none_or(|expected| expected != actual)
            }))
    }
    pub fn allowed(&self, entry: &Value) -> Result<bool> {
        let Some(rules) = entry.get("rules").and_then(Value::as_array) else {
            return Ok(true);
        };
        let mut allow = false;
        for rule in rules {
            if self.matches(rule)? {
                allow = text(rule, "action") == "allow";
            }
        }
        Ok(allow)
    }
    pub fn library_allowed(&self, library: &Value) -> Result<bool> {
        if !self.allowed(library)? {
            return Ok(false);
        }
        self.platform.library_matches(text(library, "name"))
    }
}
