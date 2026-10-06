//! Native transport for the maintained V8 dominator graph. No graph algorithm
//! is copied here. A second streaming pass looks up bounded direct incoming
//! parents because the upstream native API does not expose incoming edges.
//! Raw input stays in memory; stdout and failures never include payload names.
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::io::{self, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use v8_heap_parser::{decode_reader, Graph, NodeType};

const VERSION: &str = "papercusp-heap-retainers 0.1.0";
const REVISION: &str = "05edd8131a77790ab0e7bce2eedf5770d6bb83ae";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn safe(value: u64) -> Result<u64, &'static str> {
    if value > MAX_SAFE_INTEGER { Err("unsafe-number") } else { Ok(value) }
}

fn label(typ: &str, raw: &str) -> String {
    let mut chars = raw.bytes();
    let constructor = raw.len() <= 80 && chars.next().is_some_and(|c|
        c.is_ascii_alphabetic() || c == b'_' || c == b'$') &&
        chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$' | b'.'));
    if !typ.to_ascii_lowercase().contains("string") && (constructor ||
        matches!(raw, "(object elements)" | "(object properties)")) { raw.to_owned() }
    else { format!("({})", typ.to_ascii_lowercase()) }
}

fn node_type(typ: NodeType) -> &'static str {
    match typ {
        NodeType::Hidden => "Hidden", NodeType::Array => "Array",
        NodeType::String => "String", NodeType::Object => "Object",
        NodeType::Code => "Code", NodeType::Closure => "Closure",
        NodeType::RegExp => "RegExp", NodeType::Number => "Number",
        NodeType::Native => "Native", NodeType::Syntheic => "Synthetic",
        NodeType::ConcatString => "ConcatString", NodeType::SliceString => "SliceString",
        NodeType::BigInt => "BigInt", _ => "Other",
    }
}

fn node_row(graph: &Graph, index: usize) -> Result<Value, &'static str> {
    let node = graph.get_node(index).ok_or("invalid-node")?;
    let typ = node_type(node.typ);
    // String-family names are payloads, including identifier-shaped strings.
    let class = if typ.contains("String") { format!("({})", typ.to_ascii_lowercase()) }
        else { label(typ, node.name()) };
    Ok(json!({"index": index, "id": node.id, "type": typ, "class": class,
        "selfSizeBytes": safe(node.self_size)?,
        "retainedSizeBytes": safe(graph.retained_size(index))?, "children": node.edge_count}))
}

#[derive(Deserialize)]
struct Snapshot { meta: Meta, node_count: usize }
#[derive(Deserialize)]
struct Meta { node_fields: Vec<String>, edge_fields: Vec<String>, edge_types: Vec<Value> }

#[derive(Default)]
struct Incoming { rows: Vec<(usize, &'static str)>, count: usize, last_parent: Option<usize> }

struct Lookup<'a> {
    graph: &'a Graph,
    targets: &'a mut HashMap<usize, Incoming>,
    maximum: usize,
}
impl<'de> DeserializeSeed<'de> for Lookup<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Lookup<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("snapshot map") }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let mut snapshot: Option<Snapshot> = None;
        let mut edges_seen = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "snapshot" if snapshot.is_none() => { snapshot = Some(map.next_value()?); }
                "edges" if !edges_seen => {
                    let snapshot = snapshot.as_ref().ok_or_else(|| de::Error::custom("metadata-order"))?;
                    if snapshot.node_count != self.graph.nodes().len() || snapshot.meta.node_fields.is_empty() {
                        return Err(de::Error::custom("node-count"));
                    }
                    let meta = &snapshot.meta;
                    let ti = meta.edge_fields.iter().position(|f| f == "type")
                        .ok_or_else(|| de::Error::custom("edge-type"))?;
                    let to = meta.edge_fields.iter().position(|f| f == "to_node")
                        .ok_or_else(|| de::Error::custom("edge-target"))?;
                    let names = meta.edge_types.get(ti).and_then(Value::as_array)
                        .ok_or_else(|| de::Error::custom("edge-types"))?;
                    let types: Vec<_> = names.iter().map(|v| match v.as_str() {
                        Some("context") => Ok("Context"), Some("element") => Ok("Element"),
                        Some("property") => Ok("Property"), Some("internal") => Ok("Internal"),
                        Some("hidden") => Ok("Hidden"), Some("shortcut") => Ok("Shortcut"),
                        Some("weak") => Ok("Weak"), Some("invisible") => Ok("Invisible"),
                        _ => Err(de::Error::custom("unsupported-edge-type")),
                    }).collect::<Result<_, A::Error>>()?;
                    map.next_value_seed(EdgeLookup { graph: self.graph, targets: self.targets,
                        maximum: self.maximum, width: meta.edge_fields.len(), node_width: meta.node_fields.len(),
                        ti, to, types: &types })?;
                    edges_seen = true;
                }
                "snapshot" | "edges" => return Err(de::Error::custom("duplicate-field")),
                _ => { map.next_value::<IgnoredAny>()?; }
            }
        }
        if !edges_seen { return Err(de::Error::custom("missing-edges")); }
        Ok(())
    }
}

struct EdgeLookup<'a> {
    graph: &'a Graph, targets: &'a mut HashMap<usize, Incoming>, maximum: usize,
    width: usize, node_width: usize, ti: usize, to: usize, types: &'a [&'static str],
}
impl<'de> DeserializeSeed<'de> for EdgeLookup<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> { d.deserialize_seq(self) }
}
impl<'de> Visitor<'de> for EdgeLookup<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("numeric edges") }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let mut field = 0;
        let mut type_id = 0;
        let mut target = 0;
        let mut parent = 0;
        let mut remaining = 0;
        let mut edges = 0usize;
        while let Some(value) = seq.next_element::<usize>()? {
            if field == self.ti { type_id = value; }
            if field == self.to { target = value; }
            field += 1;
            if field != self.width { continue; }
            field = 0;
            while remaining == 0 {
                let node = self.graph.get_node(parent).ok_or_else(|| de::Error::custom("excess-edges"))?;
                remaining = node.edge_count;
                if remaining == 0 { parent += 1; }
            }
            let typ = self.types.get(type_id).ok_or_else(|| de::Error::custom("invalid-edge-type"))?;
            if target % self.node_width != 0 || target / self.node_width >= self.graph.nodes().len() {
                return Err(de::Error::custom("invalid-edge-target"));
            }
            let index = target / self.node_width;
            // Match upstream essential-edge exclusions. Root edges and self are
            // omitted from this direct-parent view and explicitly documented.
            if parent != self.graph.root_index && parent != index && !matches!(*typ, "Weak" | "Shortcut") {
                if let Some(incoming) = self.targets.get_mut(&index) {
                    // Snapshot edges are grouped by source, so this dedups all
                    // properties from one parent without an unbounded set.
                    if incoming.last_parent != Some(parent) {
                        incoming.last_parent = Some(parent);
                        incoming.count += 1;
                        if incoming.rows.len() < self.maximum { incoming.rows.push((parent, typ)); }
                    }
                }
            }
            edges += 1;
            remaining -= 1;
            if remaining == 0 { parent += 1; }
        }
        let expected: usize = self.graph.nodes().iter().map(|n| n.weight.edge_count).sum();
        if field != 0 || edges != expected { return Err(de::Error::custom("incomplete-edges")); }
        Ok(())
    }
}

fn analyze(input: &[u8], limits: [usize; 4], object_ids: &[u64], phase: &mut &'static str) -> Result<Value, &'static str> {
    *phase = "decode-bytes";
    let graph = decode_reader(io::Cursor::new(input)).map_err(|_| "invalid-snapshot")?;
    if graph.nodes().is_empty() || (graph.root_index != 0 && graph.root_index != graph.nodes().len() - 1) {
        return Err("unsupported-root");
    }
    *phase = "class-dominators";
    let [top, per_class, depth, maximum] = limits;
    let groups = graph.get_class_groups(false);
    let mut selected: Vec<_> = groups.iter().collect();
    selected.sort_by_key(|g| (std::cmp::Reverse(g.retained_size), g.index));
    let mut targets = HashMap::new();
    let mut requested: HashMap<u64, Option<usize>> = object_ids.iter().map(|id| (*id, None)).collect();
    for (index, node) in graph.nodes().iter().enumerate() {
        if let Some(found) = requested.get_mut(&u64::from(node.weight.id)) {
            if found.replace(index).is_some() { return Err("ambiguous-object-id"); }
            targets.insert(index, Incoming::default());
        }
    }
    let mut rows = Vec::new();
    for group in selected.into_iter().take(top) {
        let raw = graph.get_node(group.index).ok_or("invalid-group")?.class_name();
        let class = match raw {
            "(system)" | "(array)" | "(string)" | "(object)" | "(compiled code)" |
            "(closure)" | "(regexp)" | "(number)" | "(native)" | "(synthetic)" |
            "(concatenated string)" | "(sliced string)" | "(bigint)" | "(unknown)" => raw.to_owned(),
            _ => label("class", raw),
        };
        let mut nodes = group.nodes.clone();
        nodes.sort_by_key(|i| (std::cmp::Reverse(graph.retained_size(*i)), *i));
        let mut children = Vec::new();
        for index in nodes.into_iter().take(per_class) {
            targets.insert(index, Incoming::default());
            children.push(node_row(&graph, index)?);
        }
        rows.push(json!({"class": class, "count": group.nodes.len(),
            "selfSizeBytes": safe(group.self_size)?, "retainedSizeBytes": safe(group.retained_size)?, "nodes": children}));
    }
    *phase = "direct-retainers";
    let mut deserializer = serde_json::Deserializer::from_slice(input);
    Lookup { graph: &graph, targets: &mut targets, maximum }.deserialize(&mut deserializer)
        .map_err(|_| "invalid-edge-lookup")?;
    deserializer.end().map_err(|_| "invalid-trailing-input")?;
    let mut requested_nodes: Vec<Value> = object_ids.iter().map(|id| {
        match requested[id] {
            Some(index) => Ok(json!({"id": id, "status": "found", "node": node_row(&graph, index)?})),
            None => Ok(json!({"id": id, "status": "missing"})),
        }
    }).collect::<Result<_, &'static str>>()?;
    for node in rows.iter_mut().flat_map(|g| g["nodes"].as_array_mut().unwrap()).chain(
        requested_nodes.iter_mut().filter(|r| r["status"] == "found").map(|r| &mut r["node"])) {
            let index = node["index"].as_u64().ok_or("invalid-output")? as usize;
            let incoming = targets.get(&index).ok_or("invalid-output")?;
            let mut parents = Vec::new();
            for (parent, typ) in &incoming.rows {
                let mut row = node_row(&graph, *parent)?;
                row["retainsIndex"] = json!(index); row["edgeType"] = json!(typ);
                parents.push(row);
            }
            node["retainers"] = json!(parents);
            node["retainerCount"] = json!(incoming.count);
            node["retainersTruncated"] = json!(incoming.count > maximum);
    }
    Ok(json!({"parser": "microsoft/vscode-v8-heap-tools native", "upstreamRevision": REVISION,
        "rootIndex": graph.root_index, "limits": {"top": top, "perClass": per_class,
        "retainerDepth": depth, "maxRetainers": maximum, "objectIds": object_ids}, "groups": rows,
        "requestedNodes": requested_nodes,
        "definition": "Node retained_size is dominator-owned V8 self_size; class retained sizes overlap. Not total native memory or production savings.",
        "retainerDefinition": "Depth-one unique incoming parents; excludes weak edges, non-root shortcuts, root and the queried node. First essential edge type per parent; no edge names.",
        "privacy": "String payloads, source text, filesystem names and edge/property names are omitted."}))
}

fn main() {
    // serde/upstream panics can quote input. They must never reach stderr.
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--version"] { println!("{VERSION}"); return; }
    let mut phase = "preflight";
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<Value, &'static str> {
        if args.len() != 4 && args.len() != 5 { return Err("invalid-limits"); }
        let mut limits = [0; 4];
        for (index, (arg, maximum)) in args.iter().zip([30, 10, 1, 100]).enumerate() {
            limits[index] = arg.parse().map_err(|_| "invalid-limits")?;
            if limits[index] == 0 || limits[index] > maximum { return Err("invalid-limits"); }
        }
        let object_ids = if args.len() == 5 {
            let mut ids = Vec::new();
            for value in args[4].split(',') {
                let id: u64 = value.parse().map_err(|_| "invalid-object-ids")?;
                if id == 0 || id > MAX_SAFE_INTEGER || ids.contains(&id) || ids.len() >= 64 {
                    return Err("invalid-object-ids");
                }
                ids.push(id);
            }
            ids
        } else { Vec::new() };
        phase = "read-input";
        let mut input = Vec::new();
        io::stdin().lock().take(2_147_483_649).read_to_end(&mut input).map_err(|_| "read-failed")?;
        if input.is_empty() || input.len() > 2_147_483_648 { return Err("invalid-input-size"); }
        analyze(&input, limits, &object_ids, &mut phase)
    }));
    match result {
        Ok(Ok(report)) => println!("{report}"),
        error => {
            let kind = match error { Ok(Err(kind)) => kind, _ => "upstream-panic" };
            println!("{}", json!({"error": {"phase": phase, "kind": kind}}));
            std::process::exit(1);
        }
    }
}
