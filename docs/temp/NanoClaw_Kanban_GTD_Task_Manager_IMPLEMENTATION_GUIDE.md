# NanoClaw Task Manager (Kanban + GTD) — Guia de Implementação (WhatsApp-first)

Este documento consolida tudo o que definimos: um **sistema de gestão de relacionamento + tarefas + projetos + recorrentes** via **WhatsApp**, usando **NanoClaw** e **sem alterar o código-fonte** do NanoClaw (somente arquivos de configuração, prompts e “skill” de instruções).

> **Ideia central:** usar o **scheduler nativo** do NanoClaw como “motor de lembretes/cobranças” (standups, digest, escalonamentos e reviews) e manter as **tarefas humanas** em arquivos `TASKS.json` por chat/grupo (Kanban + GTD).

---

## 1) Objetivos

### Para você (gestão)
- Criar e atribuir tarefas/projetos a subordinados via WhatsApp.
- Acompanhar execução, prazos, bloqueios, dependências e evidências.
- Receber **resumo diário** e **revisão semanal** de forma executiva.
- Cobrar automaticamente quem está sem update / atrasado / bloqueado.

### Para o time (execução)
- Receber tarefas atribuídas por WhatsApp com instruções claras.
- Atualizar status de modo natural (texto curto) ou com formato simples.
- Ter cobrança leve e constante (standup), sem microgestão manual.

---

## 2) Como o NanoClaw entra nisso (aproveitamento do mecanismo nativo)

Vamos aproveitar:
- **Scheduled Tasks** do NanoClaw (cron/interval/once) para lembretes/cobranças/relatórios.
- **Mensageria WhatsApp** (enviar mensagens ao chat).
- **Isolamento por chat/grupo** (memória e pasta por grupo).
- **Privilégios do MAIN** para orquestrar (enviar mensagens e agendar em outros chats, conforme regras do NanoClaw).

> Observação operacional importante: se você quiser receber atualizações em “quase tempo real” sem depender do digest, **coloque você + pessoa + bot no mesmo chat** do responsável. Caso contrário, você recebe principalmente via digest (consolidado no MAIN).

---

## 3) Organização por chats (workspaces)

### 3.1 Chats recomendados
- **MAIN (admin)**: seu self-chat (ou grupo só você+bot).
  - Cria tarefas, cobra, agenda rotinas, recebe dashboards.
- **Um chat por subordinado**: você + subordinado + bot.
  - Ex.: `Alexandre (Operações)`, `Rafael (SSP)`, `Laizes (Financeiro)`
- **Chats por projeto** (se necessário): várias pessoas + bot + você.
  - Ex.: `Projeto SSP Câmeras`

### 3.2 Pastas por grupo
Cada chat/grupo tem uma pasta (por convenção):
- `groups/<nome-do-grupo>/TASKS.json` = fonte da verdade
- (opcional) `TASK_LOG.md` = linha do tempo curta (mudanças importantes)
- (opcional) `TASKS.md` = visão humana gerada (se você quiser)

---

## 4) Modelo: Kanban + GTD (o “board”)

### 4.1 Colunas (Kanban GTD-friendly)
1. `inbox` — captura rápida (ainda sem clareza)
2. `clarify` — esclarecer: próxima ação, prazo, contexto, definição de pronto
3. `next` — próximas ações (já executável)
4. `doing` — em andamento (WIP limitado)
5. `waiting` — aguardando (terceiros/dependências)
6. `review` — concluído pelo executor, pendente validação/aceite
7. `done` — concluído
8. `canceled` — cancelado

### 4.2 Princípios (GTD)
- Tudo começa na **Inbox**.
- O objetivo é sempre ter **uma próxima ação concreta** (`next_action`) para itens abertos.
- Se exigir múltiplas ações → vira **project** (com checklist/subtarefas).
- Se depender de terceiros → entra em **waiting**, com `waiting_for` e um **tickler** (cobrança programada).

### 4.3 WIP (limite de “doing”)
- Regra simples: no máximo **3 itens** em `doing` por pessoa/grupo.
- Se `doing > 3`, o standup pede para escolher o que sai de `doing` (volta para `next` ou `waiting`).

---

## 5) Fonte da verdade: `TASKS.json` por grupo

### 5.1 Tipos de card
- `action`: tarefa simples (normalmente 1–3 passos)
- `project`: tarefa complexa (sempre com checklist/subtarefas)
- `recurring`: recorrente (mensal/semanal etc.), com ciclo atual e regra de recorrência

### 5.2 Campos-chave (mínimo recomendado)
- `id`, `type`, `title`, `description`
- `owner` (responsável), `stakeholders`
- `column` (Kanban), `priority`
- `next_action` (GTD) + `contexts`
- `due_at` (prazo), `tickler_at` (lembrete/cobrança), `next_checkin_at` (próxima cobrança)
- `waiting_for` (se aplicável: party/what/tickler_at)
- `checklist` (principalmente para projects)
- `last_update` + `history` (para rastreabilidade)

---

## 6) Fluxos principais (WhatsApp)

### 6.1 Criar tarefa (no MAIN)
1) Você envia um pedido de atribuição, por exemplo:
- “Criar tarefa pro Alexandre: receber e instalar o novo filtro até amanhã 17h.”
- “Criar projeto pro Rafael: acesso às câmeras da SSP — alinhar requisitos, solicitar liberação, configurar e treinar.”
- “Criar recorrente pra Laizes: pagamentos mensais (energia, impostos, custeios) todo mês.”

2) O bot deve:
- Garantir que exista `groups/<alvo>/TASKS.json` (criar se não existir).
- Inserir o card no `TASKS.json` do grupo-alvo.
- Enviar mensagem ao chat do grupo-alvo com:
  - ID, título, prazo, `next_action`, como atualizar status.
- Programar rotinas (standup/escalonamento) **preferencialmente como runners** (ver seção 7).

### 6.2 Atualizar status (no chat do responsável)
A pessoa responde naturalmente (“Já recebi, vou instalar 14h”) ou com formato simples:

**Formato recomendado (opcional):**
- `status <ID>: <frase curta>. next: <próxima ação>. bloqueio: <se houver>. previsão: <data/hora>`

O bot então:
- Atualiza `column` (ex.: `next → doing`, `doing → review`, etc.).
- Atualiza `next_action`, `checklist`, `blockers`, `waiting_for`.
- Ajusta `next_checkin_at` (quando cobrar de novo).

### 6.3 Mudança de escopo (tarefa cresce/encolhe)
- Se a tarefa ganhar etapas, o bot converte para `project` e cria checklist.
- Se virar dependência de terceiro, move para `waiting` e define `waiting_for.tickler_at`.

### 6.4 Conclusão e aceite
- Executor finaliza → move para `review` e envia evidências (foto, confirmação, resumo).
- Gestor aprova → move para `done`.

---

## 7) Scheduler do NanoClaw: como usar sem “explodir” em alarmes

### 7.1 Regra de ouro
**Evite 1 job por card.**  
Prefira **poucos runners** por grupo e um runner no MAIN.

### 7.2 Runners recomendados (mínimo)
1) **Standup Runner (por grupo)** — 1x/dia útil, 08:30  
   - Pede status das tasks abertas.
   - Cobra next_action, bloqueios e próximo update.
   - Enforça WIP.

2) **Escalation Runner (por grupo)** — 2x/dia útil, 10:00 e 16:00  
   - Cobra atrasadas, waiting sem resposta, sem update.
   - Sinaliza riscos.

3) **Manager Digest Runner (no MAIN)** — 18:00 dias úteis  
   - Lê `groups/*/TASKS.json` e consolida (atrasadas, próximas 48h, bloqueadas, sem update, WIP estourado).

4) **Weekly Review Runner (no MAIN)** — 1x/semana (ex.: segunda 09:00)  
   - Entregas, aging tasks, gargalos, melhorias e decisões.

### 7.3 Timezone
Padronize em `America/Sao_Paulo` no `meta.timezone` do `TASKS.json` e nos cron schedules.

---

## 8) Estrutura de arquivos (copiar e colar)

```text
config-examples/
  tasks/
    TASKS.json.template
  prompts/
    STANDUP.prompt.md
    MANAGER_DIGEST.prompt.md
    WEEKLY_REVIEW.prompt.md

groups/
  alexandre/
    TASKS.json
  rafael-ssp/
    TASKS.json
  laizes/
    TASKS.json

.claude/
  skills/
    add-team-task-manager/
      SKILL.md
```

---

## 9) Skill (sem alterar `src/`) — `.claude/skills/add-team-task-manager/SKILL.md`

> A skill aqui é um “manual operacional” para o agente seguir ao criar/atualizar arquivos e manter o fluxo.

```md
---
name: add-team-task-manager
description: Adds a WhatsApp-first task & accountability workflow (files + memory + scheduled routines) without modifying NanoClaw source code.
---

# Team Task Manager (No-src-change)

## Goal
Turn each WhatsApp chat into a task workspace:
- Each subordinate/project chat maintains its own `TASKS.json`
- Main chat (admin) can assign tasks, schedule follow-ups, and generate a consolidated daily dashboard.

This skill must NOT modify `src/*`. Only create/update files under:
- `groups/*`
- `config-examples/*`
- `.claude/skills/*`
- optional docs in repo root (instructions only)

## Phase 1 — Create global operating manual
Create `docs/TASK_MANAGER.md` documenting:
1) Data model: TASKS.json schema (id, type, column, due_at, next_action, contexts, waiting_for, checklist)
2) Allowed columns: inbox, clarify, next, doing, waiting, review, done, canceled
3) How users update via WhatsApp (natural language or `status <id>:`)
4) Escalation rules:
   - overdue => ping + highlight in digest
   - no update => request update
5) Recurring tasks approach:
   - recurrence template + monthly instantiation / cycle confirmation
6) Tone: concise, managerial, action-oriented.

## Phase 2 — Seed templates & prompts
Create:
- `config-examples/tasks/TASKS.json.template`
- `config-examples/prompts/STANDUP.prompt.md`
- `config-examples/prompts/MANAGER_DIGEST.prompt.md`
- `config-examples/prompts/WEEKLY_REVIEW.prompt.md`

## Phase 3 — MAIN guidance
Ensure `groups/main/CLAUDE.md` includes:
- When assigning tasks, always write into the target group's TASKS.json
- Ensure target TASKS.json exists; create if missing
- Send WhatsApp message to target chat with: ID + due + next_action + how to update
- Prefer runner-style scheduling (standup/escalation/digest/review)

## Phase 4 — Per-group guidance
For each non-main group `CLAUDE.md`:
- Keep TASKS.json updated
- Always demand next_action + next update time
- Enforce WIP for doing
- Waiting must include waiting_for + tickler_at

## Phase 5 — Scheduling playbook (instructions only)
Add a section in docs explaining suggested cron schedules:
- Standup: weekdays 08:30
- Escalation: weekdays 10:00 and 16:00
- Digest: weekdays 18:00
- Weekly review: weekly Monday 09:00
```
---

## 10) Templates e prompts (prontos)

### 10.1 `config-examples/tasks/TASKS.json.template`

```json
{
  "meta": {
    "schema_version": "1.0",
    "timezone": "America/Sao_Paulo",
    "board": {
      "columns": ["inbox", "clarify", "next", "doing", "waiting", "review", "done", "canceled"],
      "wip_limits": { "doing_default": 3 }
    },
    "gtd": {
      "contexts_example": ["@rua", "@telefone", "@computador", "@SSP", "@financeiro"]
    }
  },
  "tasks": [
    {
      "id": "T-000",
      "type": "action",
      "title": "Exemplo - tarefa simples",
      "description": "Descreva o objetivo em 1-2 linhas.",
      "owner": "nome_do_responsavel",
      "stakeholders": ["gestor"],
      "created_by": "main",
      "created_at": "2026-02-24T09:00:00-03:00",
      "updated_at": "2026-02-24T09:00:00-03:00",
      "column": "next",
      "priority": "medium",
      "next_action": "Definir a próxima ação concreta (verbo + objeto).",
      "contexts": ["@computador"],
      "due_at": null,
      "tickler_at": null,
      "next_checkin_at": null,
      "waiting_for": null,
      "checklist": [],
      "blockers": [],
      "tags": ["gtd", "kanban"],
      "links": [],
      "last_update": { "at": "2026-02-24T09:00:00-03:00", "by": "main", "summary": "Criada." },
      "history": [{ "at": "2026-02-24T09:00:00-03:00", "by": "main", "event": "created", "note": "Criada como exemplo." }]
    },
    {
      "id": "P-000",
      "type": "project",
      "title": "Exemplo - projeto (multi-etapas)",
      "description": "Projetos sempre têm checklist/subtarefas.",
      "owner": "nome_do_responsavel",
      "stakeholders": ["gestor"],
      "created_by": "main",
      "created_at": "2026-02-24T09:00:00-03:00",
      "updated_at": "2026-02-24T09:00:00-03:00",
      "column": "clarify",
      "priority": "high",
      "next_action": "Esclarecer requisitos e definir primeira entrega.",
      "contexts": ["@telefone"],
      "due_at": null,
      "tickler_at": null,
      "next_checkin_at": null,
      "waiting_for": { "party": "terceiro", "what": "informações necessárias", "tickler_at": "2026-02-25T10:00:00-03:00" },
      "checklist": [
        { "text": "Definir resultado final (definition of done)", "done": false },
        { "text": "Listar etapas", "done": false }
      ],
      "blockers": [],
      "tags": ["project"],
      "links": [],
      "last_update": { "at": "2026-02-24T09:00:00-03:00", "by": "main", "summary": "Criado em clarificar." },
      "history": []
    },
    {
      "id": "R-000",
      "type": "recurring",
      "title": "Exemplo - recorrente mensal",
      "description": "Tarefa recorrente: o bot deve instanciar e cobrar confirmação.",
      "owner": "nome_do_responsavel",
      "stakeholders": ["gestor"],
      "created_by": "main",
      "created_at": "2026-02-24T09:00:00-03:00",
      "updated_at": "2026-02-24T09:00:00-03:00",
      "column": "next",
      "priority": "high",
      "next_action": "Confirmar execução do ciclo atual.",
      "contexts": ["@financeiro"],
      "due_at": null,
      "tickler_at": null,
      "next_checkin_at": null,
      "recurrence": {
        "kind": "cron",
        "timezone": "America/Sao_Paulo",
        "cron": "0 9 25 * *",
        "note": "Todo dia 25, 09:00: instanciar ciclo do mês e pedir confirmação."
      },
      "current_cycle": { "cycle_id": "2026-02", "status": "open", "due_at": "2026-02-28T17:00:00-03:00", "last_confirmed_at": null },
      "waiting_for": null,
      "checklist": [],
      "blockers": [],
      "tags": ["recurring"],
      "links": [],
      "last_update": { "at": "2026-02-24T09:00:00-03:00", "by": "main", "summary": "Recorrente criada." },
      "history": []
    }
  ]
}
```

### 10.2 `config-examples/prompts/STANDUP.prompt.md`

```md
Você está rodando um "standup" (check-in) para ESTE chat/grupo.

Regras (Kanban + GTD):
- Fonte da verdade: o arquivo local `TASKS.json` nesta pasta do grupo.
- Considere "abertas" as tasks com column != done e != canceled.
- Faça a cobrança de forma curta e objetiva, mas sempre pedindo:
  1) status atual (em uma frase)
  2) próxima ação concreta (verbo + objeto)
  3) bloqueio / aguardando quem (se existir)
  4) previsão do próximo update (hora/data)

Kanban / WIP:
- Conte quantas tasks estão em `doing`. Se estiver > 3, peça para escolher o que sai de `doing` (volta para `next` ou `waiting`).

GTD:
- Se alguma task estiver em `inbox` ou `clarify`, peça as informações mínimas:
  - "Qual é a próxima ação?"
  - "Tem prazo?"
  - "Contexto (@rua/@telefone/@computador etc.)"

Saída:
1) Envie uma mensagem no WhatsApp com:
   - Lista das tasks abertas (até 8 itens): `ID • coluna • título • next_action • due (se houver)`
   - Perguntas de update em bullets
2) Não altere TASKS.json ainda (a atualização vem após a resposta do usuário).
```

### 10.3 `config-examples/prompts/MANAGER_DIGEST.prompt.md`

```md
Você está gerando um "Digest do Gestor" no chat MAIN.

Objetivo:
- Consolidar status de todos os grupos em `groups/*/TASKS.json`.

Procedimento:
1) Varra a pasta `groups/` e, para cada subpasta (exceto `main`), tente ler `TASKS.json`.
2) Ignore grupos sem TASKS.json.
3) Para cada task aberta (column != done/canceled), classifique:
   - Atrasadas: due_at < agora
   - Próximas 48h: due_at dentro de 48h
   - Bloqueadas/Aguardando: column == waiting OU waiting_for != null
   - Sem update: last_update.at mais antigo que 24h (padrão)
   - WIP estourado: doing > 3 no grupo

Formato da mensagem (curto, executivo):
- 🔥 Atrasadas
- ⏳ Próximas 48h
- 🚧 Aguardando / Bloqueadas
- 💤 Sem update
- ✅ Concluídas desde o último digest (se houver dados; se não, pule)

Para cada item, mostre:
`[grupo] ID • dono • coluna • título (curto) • next_action • due`

Final:
- Sugira 3 follow-ups objetivos (mensagens a cobrar), citando grupo + ID.
- Não modifique arquivos; apenas reporte.
```

### 10.4 `config-examples/prompts/WEEKLY_REVIEW.prompt.md`

```md
Você está rodando uma "Weekly Review" no chat MAIN (Kanban + GTD).

Escopo:
- Ler `groups/*/TASKS.json` e produzir uma revisão semanal.

Produzir:
1) "Entregas da semana" (done)
2) "Aging tasks" (abertas há muito tempo):
   - Use created_at se disponível e destaque as mais antigas.
3) "Gargalos":
   - Muito item em waiting
   - WIP em doing alto (>=4)
   - Muitos itens em clarify/inbox (falta esclarecimento)
4) "Qualidade GTD":
   - tasks abertas sem next_action => listar e pedir definição
   - tasks em waiting sem waiting_for.tickler_at => listar e sugerir tickler

Formato:
- Cabeçalho com semana (data atual)
- Seções em bullets com no máximo ~12 itens no total
- Feche com:
  - 3 melhorias no processo
  - 5 perguntas de decisão para o gestor

Não altere os arquivos.
```

---

## 11) Exemplos preenchidos (3 casos)

### 11.1 Alexandre — `groups/alexandre/TASKS.json`

```json
{
  "meta": {
    "schema_version": "1.0",
    "timezone": "America/Sao_Paulo",
    "board": {
      "columns": ["inbox", "clarify", "next", "doing", "waiting", "review", "done", "canceled"],
      "wip_limits": { "doing_default": 3 }
    }
  },
  "tasks": [
    {
      "id": "A-001",
      "type": "action",
      "title": "Receber e instalar o novo filtro",
      "description": "Receber o filtro e concluir a instalação com teste final (pressão/funcionamento ok).",
      "owner": "alexandre",
      "stakeholders": ["gestor"],
      "created_by": "main",
      "created_at": "2026-02-24T09:15:00-03:00",
      "updated_at": "2026-02-24T09:15:00-03:00",
      "column": "doing",
      "priority": "high",
      "next_action": "Instalar o filtro e confirmar funcionamento (foto + confirmação).",
      "contexts": ["@rua"],
      "due_at": "2026-02-25T17:00:00-03:00",
      "tickler_at": "2026-02-24T16:00:00-03:00",
      "next_checkin_at": "2026-02-24T16:00:00-03:00",
      "waiting_for": null,
      "checklist": [
        { "text": "Receber o filtro", "done": false },
        { "text": "Instalar o filtro", "done": false },
        { "text": "Testar funcionamento e registrar evidência", "done": false }
      ],
      "blockers": [],
      "tags": ["operacional"],
      "links": [],
      "last_update": {
        "at": "2026-02-24T09:15:00-03:00",
        "by": "main",
        "summary": "Tarefa criada e atribuída."
      },
      "history": [
        { "at": "2026-02-24T09:15:00-03:00", "by": "main", "event": "created", "note": "Criada no MAIN." }
      ]
    }
  ]
}
```

### 11.2 Rafael/SSP — `groups/rafael-ssp/TASKS.json`

```json
{
  "meta": {
    "schema_version": "1.0",
    "timezone": "America/Sao_Paulo",
    "board": {
      "columns": ["inbox", "clarify", "next", "doing", "waiting", "review", "done", "canceled"],
      "wip_limits": { "doing_default": 3 }
    }
  },
  "tasks": [
    {
      "id": "P-014",
      "type": "project",
      "title": "Acesso ao sistema de câmeras da SSP",
      "description": "Alinhar requisitos com SSP, obter liberação, configurar acessos e treinar equipe.",
      "owner": "rafael",
      "stakeholders": ["gestor", "SSP"],
      "created_by": "main",
      "created_at": "2026-02-24T09:25:00-03:00",
      "updated_at": "2026-02-24T09:25:00-03:00",
      "column": "clarify",
      "priority": "high",
      "next_action": "Agendar alinhamento técnico com SSP e coletar requisitos (o que precisa e formato).",
      "contexts": ["@telefone", "@SSP"],
      "due_at": "2026-03-05T17:00:00-03:00",
      "tickler_at": "2026-02-25T10:00:00-03:00",
      "next_checkin_at": "2026-02-25T10:00:00-03:00",
      "waiting_for": {
        "party": "SSP",
        "what": "ponto focal + requisitos técnicos + política de liberação",
        "tickler_at": "2026-02-25T10:00:00-03:00"
      },
      "checklist": [
        { "text": "Definir ponto focal na SSP e canal de comunicação", "done": false },
        { "text": "Levantar requisitos técnicos (VPN/IP, perfis, logs, dispositivo, etc.)", "done": false },
        { "text": "Coletar lista de pessoas (nome, CPF, e-mail, função) para liberação", "done": false },
        { "text": "Enviar dados e solicitar liberação formal", "done": false },
        { "text": "Configurar acessos e testar com SSP", "done": false },
        { "text": "Treinar equipe e registrar evidências", "done": false },
        { "text": "Checklist final / aceite do gestor", "done": false }
      ],
      "blockers": ["Sem confirmação do ponto focal da SSP"],
      "tags": ["projeto", "SSP", "acesso"],
      "links": [],
      "last_update": {
        "at": "2026-02-24T09:25:00-03:00",
        "by": "main",
        "summary": "Projeto criado em clarificar; aguardando SSP."
      },
      "history": [
        { "at": "2026-02-24T09:25:00-03:00", "by": "main", "event": "created", "note": "Criado no MAIN." }
      ]
    }
  ]
}
```

### 11.3 Laizes — recorrentes — `groups/laizes/TASKS.json`

```json
{
  "meta": {
    "schema_version": "1.0",
    "timezone": "America/Sao_Paulo",
    "board": {
      "columns": ["inbox", "clarify", "next", "doing", "waiting", "review", "done", "canceled"],
      "wip_limits": { "doing_default": 3 }
    }
  },
  "tasks": [
    {
      "id": "R-001",
      "type": "recurring",
      "title": "Pagamentos mensais de custeio e impostos (energia, tributos, etc.)",
      "description": "Executar pagamentos recorrentes e confirmar conclusão do ciclo no WhatsApp.",
      "owner": "laizes",
      "stakeholders": ["gestor"],
      "created_by": "main",
      "created_at": "2026-02-24T09:35:00-03:00",
      "updated_at": "2026-02-24T09:35:00-03:00",
      "column": "next",
      "priority": "high",
      "next_action": "Confirmar quais boletos do ciclo 2026-02 já estão disponíveis e a data prevista de pagamento.",
      "contexts": ["@financeiro", "@computador"],
      "due_at": "2026-02-28T17:00:00-03:00",
      "tickler_at": "2026-02-25T09:00:00-03:00",
      "next_checkin_at": "2026-02-25T09:00:00-03:00",
      "recurrence": {
        "kind": "cron",
        "timezone": "America/Sao_Paulo",
        "cron": "0 9 25 * *",
        "note": "Todo dia 25 às 09:00: iniciar ciclo mensal, pedir status e confirmar execução até o fim do mês."
      },
      "current_cycle": {
        "cycle_id": "2026-02",
        "status": "open",
        "due_at": "2026-02-28T17:00:00-03:00",
        "last_confirmed_at": null,
        "items": [
          { "name": "Energia/Luz", "status": "pending", "due_at": null },
          { "name": "Impostos/Tributos", "status": "pending", "due_at": null },
          { "name": "Outros custeios (mensais)", "status": "pending", "due_at": null }
        ]
      },
      "waiting_for": null,
      "checklist": [
        { "text": "Listar boletos do ciclo (o que já chegou)", "done": false },
        { "text": "Pagar energia/luz e registrar confirmação", "done": false },
        { "text": "Pagar impostos/tributos e registrar confirmação", "done": false },
        { "text": "Pagar demais custeios do mês e registrar confirmação", "done": false },
        { "text": "Enviar resumo do ciclo (valores + datas) para o gestor", "done": false }
      ],
      "blockers": [],
      "tags": ["recorrente", "financeiro"],
      "links": [],
      "last_update": {
        "at": "2026-02-24T09:35:00-03:00",
        "by": "main",
        "summary": "Recorrente criada; ciclo 2026-02 aberto."
      },
      "history": [
        { "at": "2026-02-24T09:35:00-03:00", "by": "main", "event": "created", "note": "Criada no MAIN." }
      ]
    }
  ]
}
```

---

## 12) Convenções práticas (para funcionar redondo)

### 12.1 Mensagem padrão ao atribuir
- “Tarefa **<ID>**: <título>. Prazo: <data/hora>. Próxima ação: <next_action>.  
Responda com: `status <ID>: ... next: ... bloqueio: ... previsão: ...`”

### 12.2 Waiting obrigatório
Qualquer item em `waiting` deve ter:
- `waiting_for.party`
- `waiting_for.what`
- `waiting_for.tickler_at` (quando cobrar)

### 12.3 Review e evidência
- Ao terminar, executor move para `review` e envia evidência (foto, confirmação, resumo breve).
- Você responde “Aprovado” e o bot move para `done`.

---

## 13) Passo-a-passo de implantação (checklist)

1) Criar os chats/grupos no WhatsApp:
   - MAIN
   - Alexandre, Rafael-SSP, Laizes (você + pessoa + bot)
2) Criar as pastas em `groups/` correspondentes.
3) Copiar `TASKS.json` dos exemplos para cada pasta (ou iniciar vazio).
4) Copiar os templates e prompts para `config-examples/`.
5) (Opcional) Criar `docs/TASK_MANAGER.md` com políticas e exemplos internos.
6) Agendar os runners:
   - Standup (por grupo) 08:30 dias úteis usando `STANDUP.prompt.md`
   - Escalation (por grupo) 10:00 e 16:00 (pode reutilizar o standup com foco em riscos)
   - Manager digest (MAIN) 18:00 dias úteis usando `MANAGER_DIGEST.prompt.md`
   - Weekly review (MAIN) segunda 09:00 usando `WEEKLY_REVIEW.prompt.md`
7) Rodar 1 semana e ajustar:
   - WIP default (2–4)
   - critério “sem update” (24h vs 48h)
   - campos obrigatórios (ex.: sempre exigir `next_action`)

---

## 14) O que vem depois (evoluções naturais)
- `groups/INDEX.json` para mapear pastas → nomes amigáveis, telefones, tags de projeto.
- Geração opcional de `TASKS.md` por grupo (visão humana).
- Métricas simples: lead time, aging, % waiting, taxa de atualização.
- Integração com Odoo/ERP (se você quiser ligar tarefas a tickets, OS, compras etc.).

---

**Fim.**
