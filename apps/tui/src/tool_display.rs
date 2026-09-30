//! Human names and one-line summaries for transcript tool rows
//! (pui-chat-first-ux P-008).
//!
//! The P-005 review found the default chat printing `⚙ Edit` over the raw
//! `{"file_path":…,"old_string":…}` object and naming MCP tools by their wire
//! id (`mcp__papercusp-su__coord_orient`). Claude Code shows `Update(calc.js)`,
//! `Bash(npm test)` and `papercusp-su - plans_get (MCP)`. This module is the
//! single rule set for that label: a title naming the action and its target,
//! and — only when the title does not already carry the target — a bounded
//! `key: value` summary. Raw JSON is never produced here; the transcript shows
//! it only behind the expand toggle.

use serde_json::Value;

/// How a tool call is labelled in the transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolDisplay {
    /// `Read(calc.js)`, `Bash(npm test)`, `papercusp-su · work items claimable (MCP)`.
    pub title: String,
    /// A one-line `key: value · key: value` summary, when the title does not
    /// already say everything worth saying.
    pub summary: Option<String>,
}

const TARGET_CHARS: usize = 60;

/// `mcp__<server>__<verb>` → `<server> · <verb words> (MCP)`; any other name
/// is returned unchanged. A wrapped `tools:invoke` keeps its inner name.
pub(crate) fn human_tool_name(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("mcp__") {
        if let Some((server, verb)) = rest.split_once("__") {
            if !server.is_empty() && !verb.is_empty() {
                return format!("{server} · {} (MCP)", words(verb));
            }
        }
    }
    if let Some((group, verb)) = name.split_once(':') {
        if !group.is_empty() && !verb.is_empty() && !name.contains(' ') {
            return format!("{} {}", words(group), words(verb));
        }
    }
    name.to_string()
}

fn words(id: &str) -> String {
    id.replace(['_', '-'], " ")
}

/// The call a row actually represents: a `tools:invoke` wrapper is unwrapped
/// to the tool it dispatched, so the row names that tool and its arguments.
fn effective<'a>(name: &'a str, input: Option<&'a Value>) -> (&'a str, Option<&'a Value>) {
    let wrapper = name == "tools:invoke" || name.ends_with("__tools_invoke");
    if wrapper {
        if let Some(inner) = input.and_then(|i| i.get("name")).and_then(Value::as_str) {
            return (inner, input.and_then(|i| i.get("args")));
        }
    }
    (name, input)
}

/// A path shown relative to the directory the chat was started in, the way
/// Claude Code shows `calc.js` rather than `/tmp/…/calc.js`.
fn display_path(path: &str, cwd: Option<&str>) -> String {
    let trimmed = cwd
        .map(|c| c.trim_end_matches('/'))
        .filter(|c| !c.is_empty());
    if let Some(cwd) = trimmed {
        if let Some(rel) = path.strip_prefix(cwd).and_then(|r| r.strip_prefix('/')) {
            if !rel.is_empty() {
                return rel.to_string();
            }
        }
    }
    path.to_string()
}

fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

fn str_arg<'a>(input: Option<&'a Value>, key: &str) -> Option<&'a str> {
    input
        .and_then(|i| i.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Label one tool call. `cwd` is the chat's launch directory, used to shorten
/// file paths; `None` shows them in full.
pub(crate) fn tool_display(name: &str, input: Option<&Value>, cwd: Option<&str>) -> ToolDisplay {
    let (name, input) = effective(name, input);
    let path = || {
        str_arg(input, "file_path")
            .or_else(|| str_arg(input, "notebook_path"))
            .or_else(|| str_arg(input, "path"))
            .map(|p| clip(&display_path(p, cwd), TARGET_CHARS))
    };
    let target = |verb: &str, target: Option<String>| ToolDisplay {
        title: match target {
            Some(t) => format!("{verb}({t})"),
            None => verb.to_string(),
        },
        summary: None,
    };
    match name {
        "Read" | "NotebookRead" => target("Read", path()),
        "Edit" | "MultiEdit" | "NotebookEdit" => target("Update", path()),
        "Write" => target("Write", path()),
        "Bash" | "shell" | "exec_command" | "local_shell" => {
            let command = str_arg(input, "command")
                .or_else(|| str_arg(input, "cmd"))
                .map(|c| clip(c, TARGET_CHARS))
                .or_else(|| {
                    input
                        .and_then(|i| i.get("command"))
                        .and_then(Value::as_array)
                        .map(|argv| {
                            let parts: Vec<&str> = argv.iter().filter_map(Value::as_str).collect();
                            clip(&parts.join(" "), TARGET_CHARS)
                        })
                });
            ToolDisplay {
                title: match command {
                    Some(c) => format!("Bash({c})"),
                    None => "Bash".to_string(),
                },
                summary: str_arg(input, "description").map(|d| clip(d, 120)),
            }
        }
        "Glob" | "Grep" => {
            let pattern = str_arg(input, "pattern").map(|p| clip(p, TARGET_CHARS));
            ToolDisplay {
                title: match pattern {
                    Some(p) => format!("Search({p})"),
                    None => "Search".to_string(),
                },
                summary: str_arg(input, "path").map(|p| format!("in {}", display_path(p, cwd))),
            }
        }
        "WebFetch" => target(
            "Fetch",
            str_arg(input, "url").map(|u| clip(u, TARGET_CHARS)),
        ),
        "WebSearch" => target(
            "Web Search",
            str_arg(input, "query").map(|q| clip(q, TARGET_CHARS)),
        ),
        "TodoWrite" => ToolDisplay {
            title: "Update todos".to_string(),
            summary: None,
        },
        "apply_patch" => ToolDisplay {
            title: "Update files".to_string(),
            summary: None,
        },
        other => ToolDisplay {
            title: human_tool_name(other),
            summary: input.and_then(|i| human_args(i, usize::MAX)),
        },
    }
}

/// A one-line `key: value · key: value` rendering of a tool's arguments —
/// scalars shown as values, containers as their size — bounded to `width`
/// characters. `None` when there is nothing worth a line.
pub(crate) fn human_args(input: &Value, width: usize) -> Option<String> {
    if width == 0 {
        return None;
    }
    let parts: Vec<String> = match input {
        Value::Object(map) => map
            .iter()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| format!("{}: {}", words(k), scalar(v)))
            .collect(),
        Value::Array(items) if !items.is_empty() => vec![scalar(input)],
        Value::Null | Value::Array(_) => Vec::new(),
        other => vec![scalar(other)],
    };
    if parts.is_empty() {
        return None;
    }
    Some(clip(&parts.join(" · "), width))
}

fn scalar(value: &Value) -> String {
    match value {
        Value::String(s) => s.split_whitespace().collect::<Vec<_>>().join(" "),
        Value::Bool(b) => if *b { "yes" } else { "no" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Null => "none".to_string(),
        Value::Array(items) => format!(
            "{} item{}",
            items.len(),
            if items.len() == 1 { "" } else { "s" }
        ),
        Value::Object(map) => format!(
            "{} field{}",
            map.len(),
            if map.len() == 1 { "" } else { "s" }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CWD: Option<&str> = Some("/tmp/proj");

    #[test]
    fn native_tools_read_like_claude_code_with_paths_relative_to_the_chat() {
        let read = tool_display(
            "Read",
            Some(&json!({"file_path": "/tmp/proj/calc.js"})),
            CWD,
        );
        assert_eq!(read.title, "Read(calc.js)");
        assert_eq!(read.summary, None);

        let edit = tool_display(
            "Edit",
            Some(&json!({
                "file_path": "/tmp/proj/src/calc.js",
                "old_string": "a",
                "new_string": "b",
                "replace_all": false
            })),
            CWD,
        );
        assert_eq!(edit.title, "Update(src/calc.js)");
        assert_eq!(edit.summary, None, "the diff below says what changed");

        let outside = tool_display("Write", Some(&json!({"file_path": "/etc/hosts"})), CWD);
        assert_eq!(outside.title, "Write(/etc/hosts)");

        let bash = tool_display(
            "Bash",
            Some(&json!({"command": "npm test", "description": "Run the tests"})),
            CWD,
        );
        assert_eq!(bash.title, "Bash(npm test)");
        assert_eq!(bash.summary.as_deref(), Some("Run the tests"));

        let codex = tool_display("shell", Some(&json!({"command": ["npm", "test"]})), CWD);
        assert_eq!(codex.title, "Bash(npm test)");

        let search = tool_display(
            "Grep",
            Some(&json!({"pattern": "fn add", "path": "/tmp/proj/src"})),
            CWD,
        );
        assert_eq!(search.title, "Search(fn add)");
        assert_eq!(search.summary.as_deref(), Some("in src"));
    }

    #[test]
    fn mcp_tools_get_a_readable_name_and_no_raw_json() {
        let call = tool_display(
            "mcp__papercusp-su__work_items_claimable",
            Some(
                &json!({"harness": "papercusp", "limit": 5, "kinds": ["bug", "task"], "full": true}),
            ),
            CWD,
        );
        assert_eq!(call.title, "papercusp-su · work items claimable (MCP)");
        let summary = call.summary.unwrap();
        assert!(
            !summary.contains('{') && !summary.contains('"'),
            "{summary}"
        );
        assert!(summary.contains("harness: papercusp"), "{summary}");
        assert!(summary.contains("kinds: 2 items"), "{summary}");
        assert!(summary.contains("full: yes"), "{summary}");

        // A tools:invoke wrapper names the tool it dispatched.
        let wrapped = tool_display(
            "mcp__papercusp-su__tools_invoke",
            Some(&json!({"name": "plans:get", "args": {"slug": "p"}})),
            CWD,
        );
        assert_eq!(wrapped.title, "plans get");
        assert_eq!(wrapped.summary.as_deref(), Some("slug: p"));

        for raw in ["mcp__papercusp-su__coord_orient", "mcp__x__y"] {
            assert!(
                !tool_display(raw, None, CWD).title.contains("mcp__"),
                "{raw}"
            );
        }
    }

    #[test]
    fn human_args_is_one_bounded_line_or_nothing() {
        assert_eq!(human_args(&json!(null), 40), None);
        assert_eq!(human_args(&json!({}), 40), None);
        assert_eq!(human_args(&json!([]), 40), None);
        assert_eq!(human_args(&json!({"a": 1}), 0), None);
        assert_eq!(
            human_args(&json!({"command": "ls"}), 40).as_deref(),
            Some("command: ls")
        );
        let long = human_args(&json!({"command": "x".repeat(200)}), 30).unwrap();
        assert!(long.chars().count() <= 30 && long.ends_with('…'), "{long}");
        let multi = human_args(&json!({"body": "one\ntwo"}), 80).unwrap();
        assert!(!multi.contains('\n'), "{multi}");
        let uni = human_args(&json!({"s": "café☕".repeat(50)}), 12).unwrap();
        assert!(uni.chars().count() <= 12, "{uni}");
    }
}
