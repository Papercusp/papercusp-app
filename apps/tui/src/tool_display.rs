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

/// The files an OMP hashline edit touches (P-025). OMP's `edit` has no path
/// argument: its `input` patch, and the result it returns, name each file in a
/// `[calc.js#5ED7]` header line. In order of first appearance, without repeats.
fn hashline_files(text: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for line in text.lines() {
        let Some(inner) = line
            .trim()
            .strip_prefix('[')
            .and_then(|l| l.strip_suffix(']'))
        else {
            continue;
        };
        let Some((path, hash)) = inner.rsplit_once('#') else {
            continue;
        };
        let path = path.trim();
        let hash_ok =
            (1..=16).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_alphanumeric());
        if !path.is_empty() && hash_ok && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// `calc.js`, or `2 files`, for a call that names its files in a list.
fn files_target(files: &[&str], cwd: Option<&str>) -> Option<String> {
    match files {
        [] => None,
        [one] => Some(clip(&display_path(one, cwd), TARGET_CHARS)),
        many => Some(format!("{} files", many.len())),
    }
}

/// A Codex `mcpToolCall` item: `(server, tool, arguments)`.
fn codex_mcp(input: Option<&Value>) -> Option<(&str, &str, Option<&Value>)> {
    let item = input?;
    if item.get("type")?.as_str()? != "mcpToolCall" {
        return None;
    }
    let server = str_arg(Some(item), "server")?;
    let tool = str_arg(Some(item), "tool")?;
    Some((server, tool, item.get("arguments")))
}

/// Codex runs every command through a login shell and reports the whole line
/// (`/bin/bash -lc 'rg --files'`); the row shows the command the model wrote.
fn strip_shell_wrapper(command: &str) -> &str {
    let trimmed = command.trim();
    let Some((shell, rest)) = trimmed.split_once(' ') else {
        return trimmed;
    };
    let shell_name = shell.rsplit('/').next().unwrap_or(shell);
    if !matches!(shell_name, "bash" | "sh" | "zsh") {
        return trimmed;
    }
    let Some(script) = ["-lc ", "-c "]
        .iter()
        .find_map(|flag| rest.trim_start().strip_prefix(flag))
    else {
        return trimmed;
    };
    let script = script.trim();
    for quote in ['\'', '"'] {
        if let Some(inner) = script
            .strip_prefix(quote)
            .and_then(|s| s.strip_suffix(quote))
        {
            return inner;
        }
    }
    script
}

/// Claude's Read output numbers each line (`    12\tconst …`, shown with the
/// tab already widened to spaces, or `12→const …` in older builds).
fn is_numbered_line(line: &str) -> bool {
    let rest = line.trim_start();
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0
        && rest[digits..]
            .chars()
            .next()
            .is_some_and(|c| c.is_whitespace() || c == '→')
}

fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// The single line a finished call collapses to (pui-chat-first-ux P-025), the
/// way Claude Code prints `⎿ Read 40 lines` and Codex `└ …`: what came back, in
/// words, for reads and searches; otherwise the output's first line and how
/// many more there are. `width` bounds the line in characters.
pub(crate) fn result_summary(
    name: &str,
    input: Option<&Value>,
    text: &str,
    width: usize,
) -> String {
    let (name, input) = effective(name, input);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let n = lines.len();
    let summary = match name {
        "Read" | "NotebookRead" | "read" => {
            let numbered = lines.iter().filter(|l| is_numbered_line(l)).count();
            Some(format!(
                "Read {}",
                count(if numbered > 0 { numbered } else { n }, "line", "lines")
            ))
        }
        "Glob" | "glob" | "find" | "ls" => Some(format!("Found {}", count(n, "file", "files"))),
        "Grep" | "grep" => Some(match str_arg(input, "output_mode") {
            Some("content") => format!("Found {}", count(n, "line", "lines")),
            Some("count") => format!("Found matches in {}", count(n, "file", "files")),
            _ => format!("Found {}", count(n, "file", "files")),
        }),
        // An OMP hashline edit returns the changed region under its
        // `[calc.js#FB74]` header; say which file changed, not the header.
        "Edit" | "MultiEdit" | "edit" => {
            files_target(&hashline_files(text), None).map(|t| format!("Updated {t}"))
        }
        _ => None,
    };
    if let Some(summary) = summary {
        return clip(&summary, width.max(1));
    }
    let first = lines.first().map(|l| l.trim()).unwrap_or("");
    if n <= 1 {
        return clip(first, width.max(1));
    }
    let more = format!(" … +{}", count(n - 1, "line", "lines"));
    let room = width.saturating_sub(more.chars().count()).max(8);
    format!("{}{more}", clip(first, room))
}

/// Label one tool call. `cwd` is the chat's launch directory, used to shorten
/// file paths; `None` shows them in full.
pub(crate) fn tool_display(name: &str, input: Option<&Value>, cwd: Option<&str>) -> ToolDisplay {
    // P-025: a Codex MCP call arrives named by its bare tool (`plans_get`) with
    // the server and arguments inside the item; label it like Claude's MCP row.
    if let Some((server, tool, arguments)) = codex_mcp(input) {
        return ToolDisplay {
            title: format!("{server} · {} (MCP)", words(tool)),
            summary: arguments.and_then(|a| human_args(a, usize::MAX)),
        };
    }
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
        // OMP names its built-in tools in lower case (`read`, `edit`, `bash`).
        "Read" | "NotebookRead" | "read" => target("Read", path()),
        "Edit" | "MultiEdit" | "NotebookEdit" | "edit" => target(
            "Update",
            path().or_else(|| {
                files_target(&hashline_files(str_arg(input, "input").unwrap_or("")), cwd)
            }),
        ),
        "Write" | "write" => target("Write", path()),
        "ls" => target("List", path()),
        // P-025: Codex reports its edits as one `fileChange` item.
        "fileChange" => {
            let changes = input
                .and_then(|i| i.get("changes"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            match changes {
                [one] => {
                    let verb = match one.pointer("/kind/type").and_then(Value::as_str) {
                        Some("add") => "Write",
                        Some("delete") => "Delete",
                        _ => "Update",
                    };
                    target(
                        verb,
                        str_arg(Some(one), "path")
                            .map(|p| clip(&display_path(p, cwd), TARGET_CHARS)),
                    )
                }
                [] => target("Update files", None),
                many => target("Update", Some(format!("{} files", many.len()))),
            }
        }
        "webSearch" => target(
            "Web Search",
            str_arg(input, "query").map(|q| clip(q, TARGET_CHARS)),
        ),
        "Bash" | "bash" | "shell" | "exec_command" | "local_shell" | "commandExecution" => {
            let command = str_arg(input, "command")
                .or_else(|| str_arg(input, "cmd"))
                .map(|c| clip(strip_shell_wrapper(c), TARGET_CHARS))
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
        "Glob" | "Grep" | "glob" | "grep" | "find" => {
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

    /// P-025: Codex and OMP calls get the same `verb(target)` rows as Claude's.
    #[test]
    fn codex_and_omp_tool_calls_get_claude_style_rows() {
        let cwd = Some("/w");
        let title = |name: &str, input: Value| tool_display(name, Some(&input), cwd).title;
        // OMP's lower-case built-ins.
        assert_eq!(
            title("read", json!({"path": "/w/calc.js"})),
            "Read(calc.js)"
        );
        assert_eq!(
            title("edit", json!({"path": "/w/calc.js"})),
            "Update(calc.js)"
        );
        // OMP's hashline edit names its file only in the patch header (the
        // shape a real OMP session wrote, 2026-10-06).
        let hashline = json!({"i": "add c", "input": "\n[calc.js#5ED7]\nPUT 1.=3:\n+x\n"});
        assert_eq!(title("edit", hashline), "Update(calc.js)");
        let two = json!({"input": "[a.js#AB12]\n+x\n[b.js#CD34]\n+y\n[a.js#EF56]\n+z\n"});
        assert_eq!(title("edit", two), "Update(2 files)");
        assert_eq!(title("edit", json!({"input": "[not a header]"})), "Update");
        assert_eq!(
            title("write", json!({"path": "/w/new.js"})),
            "Write(new.js)"
        );
        assert_eq!(
            title("bash", json!({"command": "npm test"})),
            "Bash(npm test)"
        );
        assert_eq!(title("grep", json!({"pattern": "TODO"})), "Search(TODO)");
        // Codex items: the login-shell wrapper is not the command.
        let command = json!({"type": "commandExecution", "command": "/bin/bash -lc 'rg --files'"});
        assert_eq!(title("commandExecution", command), "Bash(rg --files)");
        let plain = json!({"type": "commandExecution", "command": "ls -la"});
        assert_eq!(title("commandExecution", plain), "Bash(ls -la)");
        let one = json!({"type": "fileChange", "changes": [
            {"path": "/w/calc.js", "kind": {"type": "update", "move_path": null}, "diff": ""}
        ]});
        assert_eq!(title("fileChange", one), "Update(calc.js)");
        let added = json!({"type": "fileChange", "changes": [
            {"path": "/w/new.js", "kind": {"type": "add"}, "diff": "x"}
        ]});
        assert_eq!(title("fileChange", added), "Write(new.js)");
        let two = json!({"type": "fileChange", "changes": [
            {"path": "/w/a.js", "kind": {"type": "update"}, "diff": ""},
            {"path": "/w/b.js", "kind": {"type": "update"}, "diff": ""}
        ]});
        assert_eq!(title("fileChange", two), "Update(2 files)");
        let mcp = json!({"type": "mcpToolCall", "server": "papercusp-su", "tool": "plans_get",
            "arguments": {"slug": "p"}});
        let shown = tool_display("plans_get", Some(&mcp), cwd);
        assert_eq!(shown.title, "papercusp-su · plans get (MCP)");
        assert_eq!(shown.summary.as_deref(), Some("slug: p"));
    }

    /// P-025: the one line a finished call collapses to.
    #[test]
    fn result_summary_says_what_came_back_in_one_line() {
        let read =
            "     1  const a = 1;\n     2  const b = 2;\n\n<system-reminder>x</system-reminder>";
        assert_eq!(result_summary("Read", None, read, 80), "Read 2 lines");
        assert_eq!(result_summary("Read", None, "only\n", 80), "Read 1 line");
        assert_eq!(
            result_summary("Glob", None, "a.rs\nb.rs", 80),
            "Found 2 files"
        );
        assert_eq!(
            result_summary(
                "Grep",
                Some(&json!({"output_mode": "content"})),
                "a:1:x",
                80
            ),
            "Found 1 line"
        );
        assert_eq!(result_summary("Bash", None, "ok", 80), "ok");
        // OMP's edit result leads with the raw `[file#hash]` header.
        assert_eq!(
            result_summary("edit", None, "[calc.js#FB74]\n1:function add(a, b, c = 0) {", 80),
            "Updated calc.js"
        );
        // Claude's Edit result has no header: its first line stays.
        assert_eq!(
            result_summary("Edit", None, "The file /p/calc.js has been updated.", 80),
            "The file /p/calc.js has been updated."
        );
        assert_eq!(
            result_summary("Bash", None, "\n\nfirst\nsecond\nthird", 80),
            "first … +2 lines"
        );
        let long = result_summary("Bash", None, &format!("{}\nmore", "x".repeat(200)), 30);
        assert!(
            long.ends_with(" … +1 line") && long.chars().count() <= 30,
            "{long}"
        );
        // A wrapped tools:invoke call is summarised as the tool it ran.
        let wrapped = json!({"name": "Read", "args": {}});
        assert_eq!(
            result_summary("tools:invoke", Some(&wrapped), "  1  x", 80),
            "Read 1 line"
        );
    }
}
