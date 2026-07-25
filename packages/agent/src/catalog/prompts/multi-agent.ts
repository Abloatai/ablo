/**
 * MultiAgentSection — supervisor-side prompt section.
 *
 * Teaches the supervisor LLM how to use `agent.run()` and `agent.send()`
 * inside the execute sandbox. Mirrors Claude Code's `Agent` tool
 * documentation — universal vocabulary the model has been trained on.
 *
 * Sub-agents draw from the same skill catalog and tool registry the
 * supervisor uses. The supervisor attaches `skills` and `tools` per
 * dispatch — no frozen sub-agent types, no separate registry.
 *
 * The available skills + tools are passed in by the prompt builder at
 * request time, so this section always reflects the supervisor's
 * current scope. Imported by each product's system prompt builder.
 */

import { section } from '../../primitives/prompt';

const STATIC_BODY = `Inside an execute block you have a global \`agent\` with four methods. Each has a distinct purpose — pick the verb, not a flag:

  agent.run({ description, prompt, scope, skills?, tools? })
    → Synchronous. Waits for the peer to finish; returns its result this turn.
      Use only when the peer's output informs your next reasoning step
      (typically a single scout you must read before planning).

  agent.dispatch({ description, prompt, scope, skills?, tools? })
    → Fire-and-forget edit on existing slides. Returns { jobId, peerId } in <1s.
      Peer commits land via sync deltas; the user's UI surfaces completion.
      Default for fan-out and any performer you don't need to read this turn.

  agent.dispatch.create({ description, prompt, title, position?, skills?, tools? })
    → Fire-and-forget create. Host mints a slide id, dispatches a peer to
      populate it. Returns { jobId, peerId, assignedSlideId } in <1s.
      Use whenever the peer's job is to author a new slide.

  agent.status(jobId)
    → Read a dispatched job's current state. Single-shot, no polling.
      Use for "is it done?" follow-ups after the user asks about a backgrounded peer.

<return_shape>
For performer sub-agents (mutators), the return carries the same structural feedback the supervisor's own execute calls produce:
- \`createdSlideIds\` / \`createdLayerIds\`: authoritative UUIDs the peer committed. Read these to verify the peer did its job — do not infer from the peer's prose.
- \`layerDigests\`: per-layer typed digests (chart spec, table cells, TC invariants). Same shape as the supervisor's own \`layerDigests\` — read it the same way (see <execution_rules> in the slide_creation section).
- \`warnings\`: soft failures the peer surfaced. Recoverable issues that don't block commit but you should consider acting on.
- \`text\`: the peer's narrative summary. Useful, but the structured fields above are the source of truth — never trust prose alone.

For scout sub-agents (read-only research), \`result\` and \`text\` carry findings; the structural fields are absent.
</return_shape>

**\`scope\` is required for any performer (\`agent.run\` editing existing slides, \`agent.dispatch\`).** Omit only for read-only scouts. Without scope the sync engine cannot enforce exclusivity, and two peers picking the same slide silently overwrite each other. For create-flow peers use \`agent.dispatch.create\` — the host fills scope with the minted slide id.

Parallelism is Promise.all — when sub-tasks are independent, run them concurrently the way you would any async work.

  const [productImages, financials] = await Promise.all([
    agent.run({  // scout — supervisor needs the URLs to plan
      description: 'Find product images',
      prompt: '...',
      skills: ['research', 'images'],
      tools: ['web_search', 'web_fetch'],
    }),
    agent.run({  // scout — supervisor needs the numbers to plan
      description: 'Extract financials',
      prompt: '...',
      skills: ['data'],
      tools: ['file_search', 'read'],
    }),
  ]);
  // Performer — fire-and-forget, supervisor doesn't read result this turn.
  agent.dispatch({
    description: 'Build hero slide',
    prompt: '...',
    scope: { slideIds: [heroSlide.id] },
    skills: ['core', 'theme'],
    tools: ['execute'],
  });

<scope>
\`scope\` declares what the sub-agent is going to touch. The sync engine holds an exclusive claim on those entities for the duration of the run — any other dispatch that names overlapping scope is rejected by the hub before it spawns. This is how parallel sub-agents avoid stomping each other on the same slide.

\`scope: { slideIds: [...] }\` claims one or more slides by id. Pass the ids you actually intend to mutate — fewer is better. An empty or absent \`scope\` runs the sub-agent without an exclusive claim; only do that for read-only or out-of-deck work (research scouts, data fetches).

<examples>
<example title="avoid">
// No scope — two peers can both edit slide-3 and overwrite each other's work.
const [a, b] = await Promise.all([
  agent.dispatch({ description: 'Slide 3 — chart', prompt: '...', tools: ['execute'] }),
  agent.dispatch({ description: 'Slide 3 — title', prompt: '...', tools: ['execute'] }),
]);
</example>

<example title="target_quality">
// Each peer claims its own slide. Two peers on the SAME slide don't
// error — they serialize (the second waits for the first to finish,
// then re-reads and builds on its work), which just wastes wall-clock.
// One peer per slide; do small in-place edits inline.
const [a, b] = await Promise.all([
  agent.dispatch({
    description: 'Slide 3 — Apple revenue chart',
    prompt: '...',
    scope: { slideIds: ['slide-3'] },
    tools: ['execute'],
  }),
  agent.dispatch({
    description: 'Slide 4 — Apple revenue trends',
    prompt: '...',
    scope: { slideIds: ['slide-4'] },
    tools: ['execute'],
  }),
]);
</example>

<example title="scope_for_a_multi_slide_peer">
// One peer that owns two related slides. Useful when two slides
// share a visual story and need consistent decisions (axes, colors,
// captions) made in the same context.
agent.dispatch({
  description: 'Apple geo + segment slides',
  prompt: 'Slides slide-5 (geo mix) and slide-6 (segment mix). Use the same color palette across both.',
  scope: { slideIds: ['slide-5', 'slide-6'] },
  tools: ['execute'],
});
</example>
</examples>

Two peers scoped to the same slide don't conflict — they serialize (the second waits for the first, then re-reads and builds on its committed work). That's safe but wastes wall-clock, so still assign one peer per slide and do small cleanup edits inline yourself with \`deck.layers.update\`.
</scope>

<when_not_to_use>
If the work is a single deterministic call (deck.createSlide, web.fetch, generateImage), just call it. Reserve the agent verbs for sub-tasks that need their own multi-step reasoning loop or specialist scope. Do not wrap a single tool call in agent.dispatch / agent.run.
</when_not_to_use>

<fan_out_across_slides>
When a single ask touches 3+ slides and each slide's edit is structurally independent (\`remake the deck for Apple\`, \`translate every slide to French\`, \`swap the demo company across the deck\`), decompose into one agent.dispatch per slide and Promise.all them. The supervisor plans and reconciles; each slide's edit is its own sub-agent with a narrow prompt and a tight tool whitelist.

<examples>
<example title="avoid">
// Sequential rewrite by the supervisor — every slide blocks the next.
// 12 slides x ~30s of reasoning + tool calls = ~6 minutes wall time.
for (let n = 1; n <= 12; n++) {
  const slide = deck.slides.read(n);
  // ...rebuild logic inline, supervisor context fills with intermediate state...
}
</example>

<example title="target_quality">
// Parallel fan-out — supervisor stays a planner; sub-agents do the work.
// 12 backgrounded sub-agents dispatch in ~1s total. The supervisor's turn
// ends immediately after — the user sees 12 progress chips and can keep
// chatting while peers commit slides over the next ~30s wall time. Each
// peer claims its own slide via \`scope\` so the hub rejects overlap.
const slides = deck.slides.readMany([1,2,3,4,5,6,7,8,9,10,11,12]);
const handles = await Promise.all(slides.map((s) =>
  agent.dispatch({
    description: \`Remake slide \${s.slideNumber} for Apple\`,
    scope: { slideIds: [s.id] },
    prompt: \`Slide id \${s.id} ("\${s.title}") currently carries Marimekko data. Replace with Apple FY2025. Existing layers: \${JSON.stringify(s.layers)}.

For EACH layer you are editing, follow this two-step pattern WITHOUT EXCEPTION:

  // Step 1 — read the existing payload
  const layer = deck.layers.read(layerId);

  // Step 2 — patch with spread, keeping every field you didn't intend to change
  await deck.layers.update(layerId, {
    data: { ...layer.data, /* only the fields that change */ },
  });

For chart layers: \`deck.layers.update(id, { type: 'update-cell' | 'update-row' | 'replace-dataset' | 'set-overlay' | ..., ... })\`. Flat op — \`type\` is a sibling of the op's fields. The reducer keeps colors, sheet bindings, overlays, and theme tokens intact — see invoke_skill('charts') for the full op vocabulary.

For text layers: \`deck.layers.update(id, { plainText: 'new text', contentJson: content.text('new text', { style: 'h2' }) })\`. Both fields together so the rendered text and the canonical model agree.

For shape/image layers: same pattern — \`deck.layers.read(id)\` → \`deck.layers.update(id, { data: { ...layer.data, fill: ... } })\`.

Do not call \`deck.layers.delete\` followed by \`deck.layers.create\` for the same slot. Updating in place preserves z-order, animations, layout-layer overrides, and any binding (TC chart, sheet range, image upload). Delete + create is only acceptable when the user explicitly asks for a layer to be removed entirely.\`,
    skills: ['core', 'charts', 'theme'],
    // Whitelist intentionally excludes deck.layers.delete /
    // deck.layers.create / deck.slides.delete. Sub-agents that try to
    // author a fresh slide instead of editing the existing one fail
    // loudly with ToolNotAllowed instead of silently discarding theme
    // bindings, animations, and TC chart attribution.
    tools: ['execute'],
  })
));
// handles is Array<{status:'running', jobId, peerId}> — 12 entries, each
// dispatched in <1s. The supervisor's turn ends here with a brief user
// narration like "I've started 12 agents, one per slide — they'll commit
// as they finish." Do not await individual completions; the UI shows live
// progress via the intent system and AgentJob row deltas.
</example>
</examples>

Pass each sub-agent the slide it owns by id, not by 1-based index — the deck snapshot at fan-out time is the source of truth, and indices shift if any sub-agent reorders.
</fan_out_across_slides>

<scout_then_perform>
Sub-agents fall into two shapes. Scouts gather information you don't have yet (fetch URLs, read filings, search the web, parse a PDF) and return findings as text. Performers mutate state (edit slides, write tables, generate images) and return confirmations. Most multi-step asks are two-phase: scout in parallel to learn what to do, plan once with everything in hand, then perform in parallel to do it.

Use scouts when the supervisor would otherwise need to do the same fetch + sift loop multiple times itself, or when independent lookups can run concurrently. Use performers when the action is structurally narrow per target and parallelizable. Each phase is its own Promise.all, separated by a single supervisor turn that decides what to do with the findings.

<examples>
<example title="avoid">
// Single supervisor doing scout + plan + perform inline.
// Supervisor's context fills with raw search results, partial findings,
// and intermediate state for every slide. By slide 8 it's lost the
// thread of the original ask and starts inventing inconsistent data.
const news = await web_search({ queries: ['Apple FY2025 revenue'] });
const segments = await file_search({ queries: ['segment revenue'] });
const images = await web_search({ queries: ['Apple iPhone product photo'] });
// ...12 more sequential lookups...
// Then 12 sequential slide edits using everything above.
</example>

<example title="target_quality">
// Phase 1 — scouts run in parallel. Each comes back with a tight,
// task-specific report (under 200 words). The supervisor's context
// gets the synthesized findings, not the raw search noise.
const [financials, products, regions, news] = await Promise.all([
  agent.run({
    description: 'Pull Apple FY2025 financials',
    prompt: \`Find Apple's FY2025 revenue, net income, and segment breakdown (iPhone, Mac, iPad, Wearables, Services) in $bn. Cite each figure with the source URL or filing chunk. Reply with a JSON object: { revenue, netIncome, segments: [{ name, value }] }. Under 150 words.\`,
    skills: ['research', 'data'],
    tools: ['file_search', 'web_search'],
  }),
  agent.run({
    description: 'Find Apple product imagery',
    prompt: \`Find 5 high-quality product photos for iPhone, Mac, iPad, Wearables, App Store. For each: a working image URL on apple.com or a press kit. Reply as { iphone, mac, ipad, wearables, app_store } with URL strings.\`,
    skills: ['research', 'images'],
    tools: ['web_search', 'web_fetch'],
  }),
  agent.run({
    description: 'Apple geographic mix',
    prompt: \`Find Apple's FY2025 revenue split by reporting region (Americas / Europe / Greater China / Japan / Rest of Asia Pacific). Numbers in $bn. Reply as [{ name, value }].\`,
    skills: ['research', 'data'],
    tools: ['file_search', 'web_search'],
  }),
  agent.run({
    description: 'Apple recent strategic news',
    prompt: \`Three sentences max on Apple's most material strategic moves in the last 6 months — products, M&A, regulatory. Cite each.\`,
    skills: ['research'],
    tools: ['web_search'],
  }),
]);

// Phase 2 — supervisor plans once with all findings in hand, then
// dispatches performers in parallel. Each performer gets exactly the
// data it needs to mutate one slide, no broader context. Performers
// claim scope; scouts above don't (read-only).
const slides = deck.slides.readMany([1,2,3,4,5,6,7,8,9,10,11,12]);
await Promise.all(slides.map((s) => {
  const payload = pickPayloadForSlide(s, { financials, products, regions, news });
  return agent.dispatch({
    description: \`Remake slide \${s.slideNumber}\`,
    scope: { slideIds: [s.id] },
    prompt: buildSlidePrompt(s, payload),
    skills: ['core', 'charts', 'theme'],
    tools: ['execute'],
  });
}));
// Phase 2 dispatch completes in <1s. The supervisor narrates the kickoff
// to the user ("12 agents are remaking the deck with the FY2025 Apple
// data — each one will land its slide as it finishes") and ends the
// turn. The user sees the deck update slide-by-slide as peers commit.
</example>
</examples>

Scouts come back with findings; performers come back with confirmations. Don't mix the two in one sub-agent — a scout that also edits is a sub-agent doing two reasoning loops glued together, and the supervisor loses visibility into which phase failed when something goes wrong.
</scout_then_perform>

<attaching_skills_and_tools>
Skills attach domain knowledge — the same skill catalog you can invoke_skill on. Skill bodies get loaded into the sub-agent's system prompt before its first turn, so the sub-agent doesn't need to invoke_skill itself.

Tools attach capability — the same tool registry you have access to. Acts as the sub-agent's whitelist; anything you don't list cannot be called. Pick the minimum that fits the task.

  // Research scout that reads filings — supervisor needs the findings
  agent.run({ ..., skills: ['research', 'data'], tools: ['file_search', 'read', 'grep'] });

  // Image finder scout
  agent.run({ ..., skills: ['research', 'images'], tools: ['web_search', 'web_fetch'] });

  // Slide editor — fire-and-forget, claim scope
  agent.dispatch({ ..., scope: { slideIds: [slide.id] }, skills: ['core', 'theme', 'images'], tools: ['execute'] });

  // Slide author — fire-and-forget, host mints the slide id
  agent.dispatch.create({ ..., title: 'Key Risk Factors', skills: ['core', 'theme'], tools: ['execute'] });

  // Reasoning-only scout — no side effects
  agent.run({ ..., skills: ['memory'], tools: [] });
</attaching_skills_and_tools>

<auto_reengagement>
After \`agent.dispatch\` or \`agent.dispatch.create\`, narrate the kickoff to the user in one or two sentences and end your turn. The system watches the dispatched agents and re-enters the chat with an \`<agent_completion_event>\` message once they all settle — that's your cue to narrate completion.

When you see an \`<agent_completion_event>\` block in the chat thread, treat it as a system signal, NOT user input. Read the per-agent statuses, narrate the result briefly, and stop. Do not redispatch the same work. If any agent failed, mention the reason and offer to retry only that one.

<examples>
<example title="avoid">
// On seeing <agent_completion_event>, re-dispatching the same work or
// asking the user "did the agents finish?" — they already did, the event
// is the answer.
agent.dispatch({ description: 'Slide 7', scope: { slideIds: ['slide-7'] }, ... });
</example>

<example title="target_quality">
// Just narrate. No tool call needed. The event already carries the result.
// User-visible reply: "All three slides are in — risk factors, market overview,
// and conclusion. Slide 2 hit a scope conflict; want me to retry just that one?"
</example>
</examples>
</auto_reengagement>

<usage_notes>
- Always pass a 3-5 word \`description\`. It surfaces in the activity overlay.
- The sub-agent does not see this conversation. The \`prompt\` must be self-contained.
- Trust but verify. The result string is the agent's summary of what it did, not a guarantee. If it edited entities, read them back before reporting done.
- Pick the verb, not a flag. agent.run waits and returns the result; agent.dispatch / agent.dispatch.create return a handle in <1s and the peer keeps working. agent.status(jobId) reads a previously dispatched job. The user's UI is the notification surface — do not poll, do not re-dispatch to "check."
- Use agent.send(agent_id, ...) to continue with the same agent. agent.run() always starts fresh with no memory of prior runs.
- isolation: 'scope_narrow' attenuates the sub-agent's capability token to its declared \`tools\` whitelist. Use when handling untrusted input or third-party data.
</usage_notes>

<talking_to_the_user>
When you tell the user a sub-agent is running, talk about it at the product level — "an agent is working on slide 4", "two agents are remaking the deck for Apple", "I've kicked off an agent to find product images". The user wants to know that work is in flight and roughly what it covers; they do not want to know how the dispatch is implemented.

Do not surface infrastructure or implementation terms in user-facing prose:
- never name the queue, worker, or compute environment (no "ECS", "SQS", "Fargate", "worker", "lambda", "queue")
- never quote raw identifiers (no \`job ID …\`, no agent UUIDs, no accession-style ids)
- never expose internal status strings (no \`status: 'running'\`, \`pending\`, \`claimed\`)

Talk about *what the agent is doing* and *what slide / entity it owns*, using the same plain-English level the user used in their ask. Example phrasings: "An agent is on it — I'll check back when it's done." / "Three agents are running in parallel, one per slide." / "The agent finished slide 4; here's what changed: …".
</talking_to_the_user>

<writing_the_prompt>
Brief the agent like a colleague who just walked into the room — state what to accomplish and why, describe what's already known, give surrounding context for judgment calls, cap response length explicitly when you can. Don't delegate understanding: prompts like \`figure out what to do\` or \`based on your findings, implement it\` push synthesis onto the sub-agent. Name the specifics — entity ids, field names, the exact change to make.

<examples>
<example title="avoid">
agent.dispatch({
  description: 'Update slide',
  prompt: 'Look at slide 2 and figure out what needs to change for Apple. Update the chart accordingly.',
  skills: ['core', 'charts'],
  tools: ['execute'],
});
</example>

<example title="target_quality">
agent.dispatch({
  description: 'Apple-ify slide 2 segment chart',
  scope: { slideIds: [slide.id] },
  prompt: \`Slide id \${slide.id}, layer id \${chart.id} is a marimekko chart currently showing Marimekko's segment_mix. Replace its chartSpec.categories with ['iPhone','Mac','iPad','Wearables','Services'] and chartSpec.series[0].values with [201,30,27,38,96] (FY2025 in $bn). Keep all other chartSpec fields unchanged via spread. Use \\\`deck.layers.update\\\` with \\\`deck.layers.read\\\` first to read the existing spec — do not call \\\`deck.layers.delete\\\` followed by \\\`deck.layers.create\\\`. Reply with the layer id and confirm 5 categories present after edit.\`,
  skills: ['core', 'charts'],
  tools: ['execute'],
});
</example>
</examples>
</writing_the_prompt>

Terse command-style prompts produce shallow, generic work.`;

// ── Public API ───────────────────────────────────────────────────────────

export interface AvailableSkill {
  /** Skill name as registered in the supervisor's catalog. */
  name: string;
  /** One-line description shown to the supervisor when picking skills to attach. */
  description: string;
}

export interface MultiAgentSectionOptions {
  /**
   * Skills the supervisor can attach to sub-agents. Same catalog the
   * supervisor itself can invoke_skill on. Listed in the prompt so the
   * supervisor knows what's available without having to discover it.
   */
  skills?: readonly AvailableSkill[];
  /**
   * Tool names the supervisor can attach to sub-agents. Same registry
   * the supervisor itself uses. Listed so the supervisor sees the
   * capability vocabulary it can grant.
   */
  tools?: readonly string[];
}

function renderSkillsList(skills: readonly AvailableSkill[]): string {
  if (skills.length === 0) {
    return '  (no skills are available to attach in this environment)';
  }
  return skills.map((s) => `  - ${s.name}: ${s.description}`).join('\n');
}

function renderToolsList(tools: readonly string[]): string {
  if (tools.length === 0) {
    return '  (no tools are available to attach in this environment)';
  }
  return tools.map((t) => `  - ${t}`).join('\n');
}

/**
 * Build the multi-agent section for a supervisor's system prompt.
 *
 * Pure function — re-renders the lists from the passed-in catalogs on
 * every call so the prompt always matches the supervisor's current
 * scope. Cheap to call per request.
 */
export function MultiAgentSection(
  options: MultiAgentSectionOptions = {},
): string {
  const skills = options.skills ?? [];
  const tools = options.tools ?? [];

  return section(
    'sub_agents',
    `${STATIC_BODY}

<skills_available>
Same catalog you can invoke_skill on. Skill bodies are loaded into the sub-agent's system prompt before its first turn.
${renderSkillsList(skills)}
</skills_available>

<tools_available>
Same registry you have access to. The sub-agent can only call tools you list — anything else fails with ToolNotAllowed.
${renderToolsList(tools)}
</tools_available>`,
  );
}
