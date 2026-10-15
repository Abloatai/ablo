//! Projection of InstanceCache.add/remove's expiry and duplicate decisions.
//! Model construction, MobX, indexes, views and payloads remain outside this kernel.
use std::{collections::HashMap, hint::black_box, io::{self, Read}, time::Instant};

struct Op { kind: String, id: String, now: i64, sync: i64, action: String }
struct State {
    entries: HashMap<String, bool>, recent: HashMap<String, i64>,
    history: HashMap<String, (i64, String, i64)>, accepted: Vec<usize>, skipped: usize, scanned: u64,
}
fn run(ops: &[Op], optimized: bool) -> State {
    let mut entries = HashMap::<String, bool>::new();
    let mut recent = HashMap::<String, i64>::new();
    let mut history = HashMap::<String, (i64, String, i64)>::new();
    let mut accepted = Vec::new();
    let mut skipped = 0;
    let mut scanned = 0u64;
    let mut earliest = i64::MAX;
    for (index, op) in ops.iter().enumerate() {
        let key = format!("Item:{}", op.id);
        if op.kind == "R" { entries.remove(&op.id); recent.remove(&key); history.remove(&key); continue; }
        if op.kind == "X" { if let Some(valid) = entries.get_mut(&op.id) { *valid = false; } continue; }
        let last = recent.get(&key).copied().unwrap_or(0);
        if entries.get(&op.id) == Some(&true) || (last != 0 && op.now - last < 50) ||
            (op.sync != 0 && history.get(&key).is_some_and(|h| h.0 >= op.sync)) {
            skipped += 1; continue;
        }
        if op.sync != 0 { history.insert(key.clone(), (op.sync, op.action.clone(), op.now)); }
        recent.insert(key, op.now);
        earliest = earliest.min(op.now);
        if recent.len() > 100 && (!optimized || op.now - earliest > 1000) {
            scanned += recent.len() as u64;
            recent.retain(|_, time| op.now - *time <= 1000);
            if optimized { earliest = recent.values().copied().min().unwrap_or(i64::MAX); }
        }
        entries.insert(op.id.clone(), true);
        accepted.push(index);
    }
    State {entries, recent, history, accepted, skipped, scanned}
}
fn serialize(state: State) -> String {
    let State {entries, recent, history, accepted, skipped, scanned} = state;
    let mut r: Vec<_> = recent.into_iter().collect(); r.sort();
    let mut h: Vec<_> = history.into_iter().collect(); h.sort();
    let mut e: Vec<_> = entries.into_iter().collect(); e.sort();
    // Rust Debug is valid JSON here: fixture IDs/actions are validated ASCII.
    let r = r.iter().map(|(k,t)| format!("[{k:?},{t}]")).collect::<Vec<_>>().join(",");
    let h = h.iter().map(|(k,(s,a,t))| format!("[{k:?},[{s},{a:?},{t}]]")).collect::<Vec<_>>().join(",");
    let e = e.iter().map(|(k,v)| format!("[{k:?},{v}]")).collect::<Vec<_>>().join(",");
    format!("{{\"accepted\":{accepted:?},\"skipped\":{skipped},\"scanned\":{scanned},\"recent\":[{r}],\"history\":[{h}],\"entries\":[{e}]}}")
}
fn main() -> io::Result<()> {
    let repeats: usize = std::env::args().nth(1).unwrap_or("1".into()).parse().unwrap();
    assert!((1..=1000).contains(&repeats));
    let optimized = std::env::args().nth(2).is_some_and(|s| s == "optimized");
    let mut input = String::new(); io::stdin().read_to_string(&mut input)?;
    let ops: Vec<Op> = input.lines().map(|line| {
        let f: Vec<_> = line.split('\t').collect(); assert_eq!(f.len(), 5);
        assert!(["A", "R", "X"].contains(&f[0]));
        assert!(f[1].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
        assert!(["I", "U", "D"].contains(&f[4]));
        Op { kind:f[0].into(), id:f[1].into(), now:f[2].parse().unwrap(), sync:f[3].parse().unwrap(), action:f[4].into() }
    }).collect();
    let result = serialize(run(&ops, optimized)); // warmup; parse and output are outside timed work
    let start = Instant::now();
    for _ in 0..repeats { black_box(run(black_box(&ops), optimized)); }
    println!("{{\"elapsedMs\":{},\"result\":{result}}}", start.elapsed().as_secs_f64()*1000.0/repeats as f64);
    Ok(())
}
