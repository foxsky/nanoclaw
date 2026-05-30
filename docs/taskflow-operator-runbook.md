# TaskFlow Operator Runbook — Creating a board & user from WhatsApp

**Audience:** the TaskFlow operator (project owner).

**Golden rule:** you never call tools or type commands. You talk to the agent in
plain Portuguese, **in the right WhatsApp chat**. The agent decides whether to
call `provision_root_board` / `provision_child_board` / `register_person`.
**Authorization is decided by *which chat* you message** — the host checks the
chat, not your words — and **disallowed calls are silently dropped, with no error
back.** Picking the correct chat is the whole game.

Two chats matter:

- **Main-control chat** — your operator-designated control group. The *only*
  place to create a top-level board, send an OTP, rename a person, or wire a
  destination.
- **A board chat** — any board's own WhatsApp group. From here you create *child*
  boards under it and add people to it.

If you message the wrong chat, the agent will acknowledge you, but the host
throws the request away and nothing happens. (See [Troubleshooting](#troubleshooting).)

> All claims below were verified against source (the six container tool files and
> the `register_person` / `offer_register` / `canDelegateDown` regions of
> `taskflow-engine.ts`). Paths are relative to `container/agent-runner/src/` for
> MCP tools and the repo root otherwise.

---

## A. Create a brand-new top-level (root) board

**Do this from:** the **main-control chat** only. From anywhere else the call is
silently dropped at the host gate (`checkMainControlSession`,
`src/modules/taskflow/permission.ts`; `mcp-tools/provision-root-board.ts:13-14`).

### What you do

1. Open the **main-control chat**.
2. Tell the agent you want a new board and hand it the **five required facts** —
   it cannot proceed without all of them (`mcp-tools/provision-root-board.ts:8,44-48`):
   - **subject** — board/group name (the host appends " - TaskFlow" if you omit
     it — `:18`)
   - **person_name** — the manager's display name
   - **person_phone** — any format; canonicalized host-side (`:21`)
   - **short_code** — short UPPERCASE id prefix, e.g. `ENG`, `SETD` (`:22`)
   - **person_id** — the manager's TaskFlow id (the agent usually derives/confirms it)

   > *"Cria um quadro novo: **Engenharia - TaskFlow**, gerente **Maria Souza**,
   > telefone **+55 85 99999-1234**, sigla **ENG**."*

3. Optionally override defaults; otherwise these apply
   (`mcp-tools/provision-root-board.ts:23-38`):

   | Field | Default |
   |---|---|
   | `language` | pt-BR |
   | `timezone` | America/Fortaleza |
   | `wip_limit` | 5 |
   | `max_depth` | 3 (how deep child boards may nest) |
   | `trigger` | @Case, mention-only (`requires_trigger`) |
   | `model` | claude-sonnet-4-6 |
   | standup / digest / review crons | `*_cron_local` or `*_cron_utc` |
   | `participants` | initial WhatsApp members (`<digits>@s.whatsapp.net`) |
   | `group_context` | free-text description |
   | `group_folder` | sanitized `short_code + "-taskflow"` |

   > *"… fuso **America/Sao_Paulo**, WIP **8**, standup às **08:30**."*

### What you'll see back

- A **"submitted" ack** in main-control (fire-and-forget — the agent returns when
  the call is *submitted*, not finished: `mcp-tools/provision-root-board.ts:58-60`).
- **A new WhatsApp group** appears with the manager in it.
- **A welcome message** in the new group (`buildRootWelcomeMessage`,
  `src/modules/taskflow/provision-shared.ts:510`, sent once then `markWelcomeSent`).
- **A 5-day GTD onboarding drip** scheduled: Day 1 ≈ +30 min, Days 2–5 at 09:00
  local (`scheduleOnboarding`, `provision-shared.ts:267`).
- **A confirmation** back to main-control (`buildConfirmationMessage`,
  `provision-shared.ts:116`).

> Caveat: the GTD onboarding *file bodies* are not present in this checkout (they
> live only in gitignored group folders), so that file-copy is a no-op skip
> (`provision-shared.ts:424,430`). The drip still runs — the agent renders each
> stage from the scheduled prompt at send time.

---

## B. Create a per-person sub-board (child board)

A child board is someone's own private board nested under a parent. **You just
identify the person** — runtime config (language, timezone, model, WIP, trigger)
is **inherited from the parent**, so you don't restate it. Requires the parent to
have **depth headroom** (`hierarchy_level < max_depth`).

**Do this from:** the **parent board's own chat** — and only when it has depth
headroom. Called from anywhere else (including main-control), it's silently
dropped (`mcp-tools/provision-child-board.ts:30-31`).

### What you do

1. Open the **parent board's WhatsApp group**.
2. Tell the agent to create a child board, with the four required fields
   (`mcp-tools/provision-child-board.ts:6,51-55`): **person_name**,
   **person_phone**, **person_id**, **person_role** (e.g. `developer`).
3. **Name it after the division/group, never the person.** Provide **group_name**
   (usually `"<division> - TaskFlow"`) or **group_folder** directly.
   `group_folder` is required *unless* `group_name` is provided; it never falls
   back to the person's name. If you give neither, you get, verbatim
   (`provision-child-board.ts:58`):
   > *"group_folder is required unless group_name is provided; child boards must
   > be named after the division/group, never the person"*

   > *"Cria um quadro filho para a **Ana Lima**, cargo **designer**, telefone
   > **+55 85 98888-2222**, divisão **UX - TaskFlow**."*

### What you'll see back

- A submitted ack (fire-and-forget — `provision-child-board.ts:69-71`).
- The host creates the assignee's **private WhatsApp group**, seeds the child
  board **inheriting the parent's runtime config**, wires the agent, schedules
  runners + onboarding, and **links any tasks the assignee already owned on the
  parent** (`provision-child-board.ts:30-31`).
- **Dedup:** if that person already has a board under a *different* parent, the
  host **links to it instead of duplicating** (`:31`). A link, not a new group,
  is expected behavior — not a failure.
- A child welcome message (`buildChildWelcomeMessage`, `provision-shared.ts:514`).

---

## C. Add a user to an existing board (without their own board)

Use this when someone should appear as a member/assignee on a board but should
**not** get their own child board.

**Do this from:** the **board's own chat** where the person should be added.

### What you do

Open the board's chat and **just name the person** in plain language (assign a
task to them, or "cadastra fulano"). The agent resolves the name against the
board's members (`taskflow-engine.ts:3787-3798`):

- **Exactly one match** → proceeds normally.
- **Ambiguous (>1 match)** → you **must** disambiguate; it will never
  auto-register (`:3770-3781`, string at `:3779`):
  > *Encontrei mais de uma pessoa para "{nome}":*
  > *- {Pessoa A}*
  > *- {Pessoa B}*
  >
  > *Qual delas?*
- **Zero matches** → an **offer_register** prompt (`buildOfferRegisterError`,
  `:3744-3763`, string at `:3760`):
  > *{nome} não está cadastrado(a). Membros atuais: {lista}. Quer cadastrar? {ask}*

  The `{ask}` tail depends on the board type:
  - **Leaf board** (no depth headroom — `:3753`):
    > *Preciso do \*nome exibido no grupo\* (display name do WhatsApp), telefone e cargo.*
  - **Hierarchy board** (can delegate down — `:3754`): the same **plus**:
    > *…, \*e a sigla da divisão/setor\* dele(a) (ex: SETD, SECI, SEAF) — o quadro
    > filho será criado com o nome da divisão, nunca com o nome da pessoa.*

Then answer the ask: display name, phone, role (plus division sigla if asked).

### The hierarchy caveat (important)

On a board that **can delegate down** (`canDelegateDown()`: `hierarchy_level != null`
AND `max_depth != null` AND `hierarchy_level < max_depth` — `taskflow-engine.ts:1798-1802`),
`register_person` is *designed* to auto-provision a child board for each new
member. It **requires `person_name` plus `phone`, `group_name`, and
`group_folder`** — all validated before any `board_people` INSERT
(`:9416-9430`). Missing any → verbatim error naming the missing fields (`:9427`),
ending with the escape hatch:

> *…(If the person is a manager/delegate who should NOT have their own child
> board, use add_manager/add_delegate on an existing board_people row instead of
> register_person.)*

When all fields are present, it emits an `auto_provision_request` (`:9459-9474`)
— i.e. **it provisions the child board automatically** (same outcome as Section
B). You'll see (`:9468`):

> *Quadro filho para {nome} será provisionado automaticamente.*

**Net:** on a hierarchy board, "add a person" and "create their child board" are
the same act. To add someone *without* a child board there, they must be a
manager/delegate added via `add_manager`/`add_delegate` (`:9412-9415`), or it
must be a leaf board.

---

## D. OTP / direct message (`send_otp`)

For a transactional WhatsApp message (OTP, code) directly to a phone number — e.g.
a manager not yet in any group.

**Do this from:** the **main-control chat** only. Non-main callers are silently
dropped (`mcp-tools/send-otp.ts:28-29`; host gate `src/modules/send-otp/handler.ts`).

### What you do

From main-control, tell the agent to send a message to a number. It needs
**phone** and **message** (both required, re-validated non-empty —
`mcp-tools/send-otp.ts:43,47-50`). Brazilian numbers without a country code get
**55** prepended by the adapter (`:36`).

> *"Envia pro **+55 85 99999-1234**: 'Olá Maria, seu código de acesso é 4827.'"*

### What you'll see back

A submitted ack only (fire-and-forget — `:60`). **No delivery confirmation, no
failure notice** — if the phone isn't on WhatsApp, or you weren't in main-control,
the host drops it silently (`:28-29`).

> `send_otp` is **not** the team-invite path. The board template forbids it for
> invites (`.claude/skills/add-taskflow/templates/CLAUDE.md.template:516`); board
> invites go through the engine's "Convite pendente" flow. Use `send_otp` for
> transactional OTP/codes only.

---

## Troubleshooting

Why nothing happened:

- **Wrong chat → silently dropped, no error.** The #1 cause. The container tool
  only validates input *shape* and always acks "submitted"; the **host** is
  authoritative and discards disallowed calls. Root board / OTP / rename-person /
  add-destination → **must** be main-control. Child board → **must** be the parent
  board chat *with depth headroom*. The ack is never proof of success.
- **No depth headroom →** the child-board path won't fire on a leaf board
  (`taskflow-engine.ts:1798-1802`).
- **Duplicate person → links, not a new board.** Expected
  (`provision-child-board.ts:31`).
- **Ambiguous name → you must disambiguate.** "Qual delas?" never auto-registers
  (`taskflow-engine.ts:3770-3781`).
- **Missing required fields → loud rejection** (unlike a wrong-chat drop). The
  message names exactly what's missing — answer it. (Root:
  `provision-root-board.ts:44-48`; child: `provision-child-board.ts:58`;
  hierarchy register: `taskflow-engine.ts:9420-9429`.)
- **Child board named after a person → blocked by design.** It must be the
  division/group; you'll be asked for the division sigla
  (`provision-child-board.ts:58`, `taskflow-engine.ts:3754`).

---

## Tool / gate reference

| Operation | Container tool | Host action | From which chat |
|---|---|---|---|
| Create root board | `provision_root_board` | `handleProvisionRootBoard` | **Main-control** |
| Create child board | `provision_child_board` | `handleProvisionChildBoard` | **Parent board** (w/ depth headroom) |
| Add a user | `register_person` / `api_add_board_person` → `_addBoardPersonCore` | (in-container engine write) | The board's chat |
| Rename a person | `rename_board_person` | `handleRenameBoardPerson` | **Main-control** |
| Add a destination | `add_destination` | `handleAddDestination` | **Main-control** |
| Create a bare group | `create_group` | `handleCreateGroup` | Main-control OR a board w/ depth headroom |
| Send OTP/code | `send_otp` | `handleSendOtp` | **Main-control** |

Every container tool follows the same shape: validate field shape → write a
`kind:'system'` row to `outbound.db` → return an OK "submitted" ack regardless of
whether the host will accept or silently drop the request. Authorization lives
entirely host-side (the container cannot see `messaging_groups.is_main_control` or
board depth — neither is mounted into its IO surface).

See also: [docs/v2-cutover-runbook.md](v2-cutover-runbook.md) for the migration/cutover procedure.
