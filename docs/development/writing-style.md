# Writing Style

This guide describes how to write prose in this repository. It applies to
documentation, `AGENTS.md`, code comments, commit messages, pull request
descriptions, and summaries written for a reader. Its purpose is to make every
piece of writing understandable to a reader who has not seen the code or the
conversation that produced it.

The guide has two parts. The first part explains the foundational style, which
should rarely change. The second part is a catalog of specific failure patterns
that have been observed in model-written prose. The catalog is meant to grow:
when a reader points out a new kind of writing problem, add an entry for it
instead of rewriting the foundation.

## The foundational style

### Every paragraph makes one point, and it says that point explicitly

A paragraph is a unit of argument, not a container for related facts. Before
writing a paragraph, decide what single point it should leave the reader with.
State that point in the first or second sentence, and then use the remaining
sentences to explain, support, or qualify it. A reader who reads only the first
sentence of each paragraph should come away with an accurate outline of the
document.

If a paragraph contains facts that do not support its main point, those facts
belong in a different paragraph. If a fact does not support any point the
document is making, consider whether the reader needs it at all.

### Every fact is connected to the point it supports

A fact on its own rarely tells the reader why it matters. After stating a
design fact, say what follows from it. Useful connections include a consequence
("which means that callers must..."), a reason ("because the server cannot..."),
or a contrast with the alternative that was not chosen ("instead of caching the
transcript, the adapter..."). Transition words such as *because*, *so*,
*therefore*, *however*, *instead*, and *for the same reason* make these
connections visible. When two adjacent sentences have no connecting word and no
obvious logical relationship, the reader has to invent the relationship, and
they will often invent the wrong one.

If you do not know the reason for a design decision, do not make one up. Either
find the reason in the code, the decision records, or the commit history, or
state the fact plainly and say that the reason is not documented.

### Write complete sentences in plain, literal language

Use full sentences with a subject and a verb. Do not compress several ideas into
a fragment, and do not use a semicolon to join two statements that are not
closely related. Each sentence should be readable aloud without the listener
needing to reconstruct missing words.

Use words in their ordinary meanings. Do not coin compact phrases that the
reader has to decode, such as "transport life" or "listener failures do not own
transport life." A phrase like that only has meaning to the writer, who already
knows what it stands for. Say the literal thing instead: "If an event listener
throws an exception, the adapter reports the error but keeps the connection
open." Be especially careful with metaphorical verbs such as *own*, *drive*,
*gate*, and *cross* when the subject is not a component that can actually do
that thing.

### Define terms and do not depend on private context

Introduce a technical term before relying on it, either by defining it or by
linking to the document that does. Use the names from the
[UI Language](./ui-language.md) for user-facing surfaces, and use the same name
for the same thing throughout a document.

A document must make sense on its own. Do not refer to internal plan steps,
earlier conversations, or work in progress (for example, "that is step 11")
unless the reference is explained or linked. A future reader will not have the
plan that the writer was following.

### Connect paragraphs to each other

Sections and paragraphs should follow a line of reasoning. Open a section by
saying what it covers and why it matters, and let each paragraph build on the
one before it. When the topic changes, signal the change with a transition
sentence or a new heading rather than moving silently to an unrelated fact.

### Use lists only for items that are genuinely parallel

A list is appropriate for steps in a procedure, a set of options, or several
items of the same kind that a reader may want to scan. A list is not a
substitute for explanation. Do not use bullet points, slash-separated chains
(such as "rename/compaction/export/history"), or long comma-separated runs to
avoid explaining how ideas relate to one another. When the relationship between
items matters, write it as prose.

### Explain negative statements

Statements such as "X is not supported" or "the adapter does not do Y" leave the
reader wondering whether the omission is deliberate, temporary, or accidental.
Say which one it is and what the reader should do instead. For example: "The
adapter does not support `resumeLastSession`, so callers must store the session
path returned by `getState()` and pass it back when reopening."

## A worked example

The following paragraph from an earlier draft of the sandbox client
documentation shows several of these problems at once:

> Event sequences must be strictly increasing safe integers per connection.
> Diagnostics are delivered separately from events; listener failures do not
> own transport life.

The paragraph lists three facts without stating what they have in common. The
semicolon joins two unrelated statements, and "listener failures do not own
transport life" is a coined phrase that the reader has to decode. A revised
version states its point first and connects each fact to it:

> The adapter distinguishes between problems in the data the sandbox sends and
> problems in Tauren's own code, and it responds to them differently. Every
> event from the server carries a sequence number, and each number must be
> larger than the one before it. If an event fails this check or is otherwise
> malformed, the adapter can no longer trust the connection, so it reports an
> error and closes the connection. A failure inside one of Tauren's own event
> listeners is handled differently. If a listener throws an exception while
> processing a valid event, the adapter reports the error but keeps the
> connection open, because a bug in one subscriber says nothing about whether
> the sandbox itself is healthy.

The revision is longer, but the reader no longer has to guess what the writer
meant or why the behavior matters.

## Revision checklist

Before finishing a piece of writing, reread it and check the following:

1. The first sentence of each paragraph states the point of that paragraph.
2. Every other sentence in the paragraph supports that point.
3. Each design fact is connected to a reason, a consequence, or a contrast.
4. Every sentence is complete and uses words in their ordinary meanings.
5. Every technical term is defined or linked before it is relied on.
6. The document makes sense to a reader who has not seen the code or the plan.
7. Lists contain only parallel items, and no list replaces needed explanation.

## Catalog of failure patterns

Each entry describes a specific writing problem that has been observed, shows an
example, and explains the fix. When a reader identifies a new problem, add an
entry using the same four headings. Quote the real text that caused the
problem whenever possible, because concrete examples are easier to recognize
than abstract rules.

### Fact list without a thesis

**Pattern.** A paragraph presents a sequence of true statements but never says
what they add up to.

**Example.** "After initialization and successful session replacement,
`getState()` records the actual persisted session path. Reopening requires that
explicit path; implicit `resumeLastSession` discovery is not supported by this
adapter. `getMessages()` always reads Pi history afresh, including
server-rendered custom messages. There is no persisted or authoritative host
transcript cache."

**Why it fails.** The facts share a theme, which is that Pi's session files are
the only source of truth for a conversation, but the paragraph never says so.
The reader has to infer the theme and the reason each fact matters.

**Fix.** State the theme first and connect each fact to it: "Pi's session files
inside the sandbox are the only record of a conversation, and the adapter is
designed so that Tauren never relies on a copy of its own. Once a session has
started, `getState()` reports the path of the file that Pi actually wrote, and
Tauren must pass that exact path back to reopen the session. For the same
reason, `getMessages()` reads the history from Pi every time it is called
instead of returning a transcript that Tauren stored earlier."

### Coined compressed phrase

**Pattern.** The writer invents a short phrase that stands for a longer idea and
uses it as if the reader already knows what it means.

**Example.** "Listener failures do not own transport life."

**Why it fails.** The phrase has no ordinary meaning. The reader cannot tell
what "transport life" refers to or how a failure could "own" it.

**Fix.** Write out the literal behavior: "If an event listener throws an
exception, the adapter reports the error but keeps the connection open."

### Unrelated statements joined by a semicolon

**Pattern.** Two statements about different subjects are joined with a
semicolon, which implies a close relationship that does not exist.

**Example.** "Diagnostics are delivered separately from events; listener
failures do not own transport life."

**Why it fails.** The semicolon tells the reader that the second clause
explains or extends the first, so the reader searches for a connection that is
not there.

**Fix.** Put each statement in its own sentence, and place each one in the
paragraph whose point it supports.

### Slash-separated or comma-run inventory

**Pattern.** Many capabilities are packed into a single sentence with slashes
or long comma lists.

**Example.** "The adapter maps prompts/images, abort, reload,
model/thinking/settings/resources, auth readiness, session
rename/compaction/export/history, switch/import/tree/labels/navigation/fork/clone,
and composer completions."

**Why it fails.** The sentence is hard to read, and it gives no indication of
which items matter or how they relate.

**Fix.** If the reader needs the full inventory, use a real list or a table. If
the reader only needs the point, state it directly, for example: "The adapter
implements the full `AgentClient` contract by forwarding each call to the
sandbox server," and then discuss only the calls whose behavior differs from
what the reader would expect.

### Confusing a remote call with sending a function

**Pattern.** The text calls a method “not a remotely supplied function” without
explaining what the other process actually sends.

**Why it fails.** The contrast suggests that some requests deliver functions to
be executed. In Tauren's SBX protocol, each process registers its own handlers.
A request sends a method name and data for the receiving process to use.

**Fix.** Name the sender, the data, and the handler. For example: “The host sends
`ui.render` with a surface ID and dimensions. The sandbox's registered handler
renders the component and returns text and image data.” For a local call, say
where the method is defined and what it does.

### Reference to private plan context

**Pattern.** The text refers to a plan, step number, or discussion that the
reader cannot see.

**Example.** "It is not yet exposed through backend settings/factory selection;
that is step 11."

**Why it fails.** A reader of the documentation does not have the plan, so
"step 11" carries no information.

**Fix.** Describe the current state and the planned change in plain terms, and
link to the plan or decision record if one exists: "Users cannot select this
backend yet, because the settings and client factory do not know about it. That
integration is planned as a separate change."
