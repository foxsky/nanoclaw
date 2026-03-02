> **DEPRECATED** — Early project spec. Superseded by `docs/plans/2026-02-24-taskflow-design.md` and `.claude/skills/add-taskflow/SKILL.md`.

# TaskFlow — Sistema de Gestão de Tarefas via WhatsApp para NanoClaw
## Kanban + GTD para Gestão de Equipe

---

## 1. Visão Geral

O **TaskFlow** é um skill para NanoClaw que transforma o assistente pessoal em um sistema de gestão de tarefas para equipe via WhatsApp, baseado nos princípios de **Kanban** (fluxo visual, limite de trabalho em progresso) e **GTD** (captura rápida, próxima ação sempre definida, revisão periódica).

### Princípios Kanban Aplicados

- **Quadro com colunas** — Cada tarefa está em exatamente um estágio do fluxo
- **Limite de WIP** — Cada pessoa tem um número máximo de tarefas "Em Andamento"
- **Fluxo puxado (pull)** — O responsável puxa a próxima tarefa quando tem capacidade
- **Visualização** — O daily digest funciona como a "visualização do quadro"

### Princípios GTD Aplicados

- **Captura rápida (Inbox)** — Tarefas podem ser criadas com mínimo de informação e processadas depois
- **Próxima ação** — Toda tarefa e projeto tem sempre uma próxima ação concreta e clara
- **Aguardando (Waiting For)** — Rastrear explicitamente o que depende de terceiros
- **Revisão semanal** — Análise completa do quadro toda semana
- **Projetos** — Qualquer coisa que exige mais de uma ação é um projeto com subtarefas

### Princípios de Design Técnico

- **Sem alteração do código-fonte do NanoClaw** — tudo via CLAUDE.md + tools IPC nativas
- **Aproveitamento total da infraestrutura nativa** — `schedule_task`, `send_message`, `task-scheduler.ts`
- **Linguagem natural** — o gestor fala normalmente, o agente traduz para o modelo
- **Simplicidade** — a metodologia serve ao trabalho, não o contrário

---

## 2. O Quadro Kanban

### 2.1 Colunas (Estados)

O fluxo de uma tarefa segue este quadro:

```
┌──────────┐   ┌──────────┐   ┌────────────┐   ┌────────────┐   ┌──────────┐
│  📥      │   │  ⏭️      │   │  🔄        │   │  ⏳        │   │  ✅      │
│  INBOX   │──▶│ PRÓXIMA  │──▶│ EM         │──▶│ AGUARDANDO │──▶│ CONCLUÍDO│
│          │   │  AÇÃO    │   │ ANDAMENTO  │   │            │   │          │
└──────────┘   └──────────┘   └────────────┘   └────────────┘   └──────────┘
                                    │                │
                                    └────────────────┘
                                   (pode alternar entre
                                   andamento e aguardando)
```

| Coluna | Status | Significado | Quem age |
|---|---|---|---|
| 📥 Inbox | `inbox` | Capturada, precisa ser processada (definir responsável, prazo, próxima ação) | Gestor |
| ⏭️ Próxima Ação | `next_action` | Processada, pronta para ser executada. A próxima ação está clara. | Responsável (pull) |
| 🔄 Em Andamento | `in_progress` | Sendo executada ativamente | Responsável |
| ⏳ Aguardando | `waiting_for` | Bloqueada esperando resposta/ação de terceiro | Responsável monitora |
| ✅ Concluído | `done` | Finalizada | — |
| ❌ Cancelado | `cancelled` | Cancelada | — |

### 2.2 Limite de WIP (Work in Progress)

Cada pessoa tem um limite de tarefas simultâneas em "Em Andamento":

```json
{
  "wip_limit": 3
}
```

Quando alguém tenta puxar uma tarefa além do limite, o agente avisa:
> ⚠️ Alexandre já tem 3 tarefas em andamento. Concluir ou mover alguma para "Aguardando" antes de iniciar outra.

O gestor pode sobrepor o limite se necessário ("forçar T-005 para andamento").

### 2.3 Fluxo GTD: Captura → Processamento → Execução

#### Captura Rápida (Inbox)

O gestor pode capturar ideias/tarefas rapidamente sem definir tudo:

> @Andy anotar: verificar situação do ar condicionado da sala 3

O agente cria no Inbox:
```json
{
  "id": "T-012",
  "type": "simple",
  "title": "Verificar situação do ar condicionado da sala 3",
  "status": "inbox",
  "assignee": null,
  "due_date": null,
  "next_action": null
}
```

#### Processamento (Inbox → Próxima Ação)

No daily digest ou quando o gestor pedir, o agente mostra itens no Inbox para processar:

> 📥 *Inbox (3 itens sem processar):*
> T-012: Verificar ar condicionado sala 3
> T-013: Pedir orçamento do gerador
> T-014: Renovar contrato de internet
>
> _Defina responsável, prazo e próxima ação para mover ao quadro._

O gestor processa:
> @Andy T-012 para Alexandre, prazo sexta. Próxima ação: verificar se está funcionando e reportar.

Tarefa move para "Próxima Ação" com tudo definido.

#### Próxima Ação → Em Andamento (Pull)

O responsável puxa quando começa a trabalhar:
> @Andy iniciando T-012

Ou o agente pergunta no digest individual:
> Você tem 2 tarefas em "Próxima Ação". Vai iniciar alguma hoje?

---

## 3. Modelo de Dados

### 3.1 Pessoas

```json
{
  "people": [
    {
      "id": "alexandre",
      "name": "Alexandre",
      "phone": "5586999990001",
      "role": "Técnico",
      "groups": ["infraestrutura"],
      "wip_limit": 3
    },
    {
      "id": "rafael",
      "name": "Rafael",
      "phone": "5586999990002",
      "role": "TI/Redes",
      "groups": ["infraestrutura", "segurança"],
      "wip_limit": 3
    },
    {
      "id": "laizes",
      "name": "Laízes",
      "phone": "5586999990003",
      "role": "Administrativo/Financeiro",
      "groups": ["administrativo"],
      "wip_limit": 3
    }
  ]
}
```

### 3.2 Tarefas

```json
{
  "tasks": [
    {
      "id": "T-001",
      "type": "simple",
      "title": "Receber e instalar o novo filtro",
      "status": "in_progress",
      "assignee": "alexandre",
      "priority": "normal",
      "next_action": "Instalar o filtro que já foi recebido",
      "due_date": "2026-02-28T18:00:00Z",
      "created_at": "2026-02-24T10:00:00Z",
      "scheduled_task_ids": ["reminder-T-001-2d", "reminder-T-001-due"],
      "history": [
        { "ts": "2026-02-24T10:00:00Z", "event": "created", "note": "Capturada e atribuída" },
        { "ts": "2026-02-24T10:05:00Z", "event": "inbox→next_action", "note": "Processada" },
        { "ts": "2026-02-25T09:00:00Z", "event": "next_action→in_progress", "note": "Alexandre iniciou" },
        { "ts": "2026-02-25T14:30:00Z", "event": "update", "by": "alexandre", "note": "Filtro recebido do fornecedor" }
      ]
    },
    {
      "id": "T-002",
      "type": "project",
      "title": "Acesso ao sistema de câmeras da SSP",
      "status": "in_progress",
      "assignee": "rafael",
      "priority": "high",
      "next_action": "Enviar dados (CPF e matrícula) do pessoal para a SSP",
      "due_date": "2026-03-15T18:00:00Z",
      "created_at": "2026-02-20T09:00:00Z",
      "scheduled_task_ids": ["reminder-T-002-5d", "reminder-T-002-2d"],
      "subtasks": [
        { "id": "T-002.1", "title": "Alinhar requisitos técnicos com SSP", "status": "done" },
        { "id": "T-002.2", "title": "Enviar dados de quem vai acessar", "status": "in_progress",
          "next_action": "Coletar CPF e matrícula do João e da Maria" },
        { "id": "T-002.3", "title": "Obter liberação de acesso na SSP", "status": "next_action",
          "waiting_for": null },
        { "id": "T-002.4", "title": "Configurar acessos locais", "status": "next_action" },
        { "id": "T-002.5", "title": "Treinar o pessoal", "status": "next_action" }
      ],
      "history": []
    },
    {
      "id": "R-001",
      "type": "recurring",
      "title": "Pagamentos mensais de custeio",
      "status": "active",
      "assignee": "laizes",
      "priority": "high",
      "next_action": "Efetuar pagamentos do ciclo de março",
      "recurrence": {
        "frequency": "monthly",
        "day_of_month": 5,
        "reminder_days_before": [3, 1]
      },
      "scheduled_task_ids": ["rec-R-001-d2", "rec-R-001-d4", "rec-R-001-d5", "rec-R-001-d6"],
      "checklist": [
        { "item": "Impostos federais", "required": true },
        { "item": "Impostos estaduais", "required": true },
        { "item": "Conta de luz/energia", "required": true },
        { "item": "Conta de água", "required": true },
        { "item": "Internet/telecomunicações", "required": true },
        { "item": "Aluguel", "required": false },
        { "item": "Outros custos variáveis", "required": false }
      ],
      "last_execution": {
        "period": "2026-02",
        "status": "done",
        "completed_at": "2026-02-05T17:00:00Z"
      },
      "history": []
    }
  ]
}
```

**Campos GTD-chave:**
- `next_action`: **Sempre preenchido** quando a tarefa não está no Inbox ou Concluída. É a ação concreta e imediata que precisa acontecer.
- `waiting_for`: Quando status é `waiting_for`, indica quem/o quê está sendo esperado.
- `status`: Mapeia diretamente para a coluna do quadro Kanban.

### 3.3 Mapeamento de Estados

| Status | Coluna Kanban | Regra GTD | Emoji |
|---|---|---|---|
| `inbox` | 📥 Inbox | Capturado, precisa processar | 📥 |
| `next_action` | ⏭️ Próxima Ação | Processado, pronto para executar | ⏭️ |
| `in_progress` | 🔄 Em Andamento | Sendo executado (conta no WIP) | 🔄 |
| `waiting_for` | ⏳ Aguardando | Esperando terceiro (não conta no WIP) | ⏳ |
| `done` | ✅ Concluído | Finalizado | ✅ |
| `cancelled` | ❌ Cancelado | Descartado | ❌ |
| `active` | — | Recorrente com ciclo ativo | 🔁 |

---

## 4. Infraestrutura Nativa Aproveitada

(Sem alteração de código — apenas CLAUDE.md + tools IPC)

### Tools IPC Nativas

| Tool IPC | Uso no TaskFlow |
|---|---|
| `schedule_task` | Daily digest (cron), revisão semanal (cron), lembretes de prazo (once), ciclos de recorrência (cron) |
| `send_message` | Notificar subordinados, enviar digests individuais, cobranças |

### Scheduled Tasks Criados pelo Agente

| Job | Tipo | Cron/Valor | Propósito |
|---|---|---|---|
| Daily Digest | `cron` | `0 11 * * 1-5` (08:00 BRT, seg-sex) | Quadro Kanban + digest individual |
| Revisão Semanal | `cron` | `0 14 * * 5` (11:00 BRT, sexta) | Revisão GTD completa |
| Lembrete de prazo | `once` | 2 dias antes | Lembrete amigável ao responsável |
| Cobrança de prazo | `once` | No dia do prazo | Cobrança direta |
| Recorrência (lembrete) | `cron` | Dias antes do vencimento | Lembrete do ciclo |
| Recorrência (cobrança) | `cron` | Dia do vencimento | Cobrança da checklist |
| Recorrência (atraso) | `cron` | Dia seguinte ao vencimento | Escalonamento |

---

## 5. Daily Digest como Quadro Kanban

O daily digest (seg-sex 08:00) funciona como a **visualização do quadro**. É o momento em que todos "olham para o board".

### Para o Gestor (no grupo):

> 📊 *Quadro — Segunda, 24/02/2026*
>
> 📥 *Inbox (2):*
> T-012: Verificar ar condicionado sala 3
> T-013: Orçamento do gerador
> _→ Processar: definir responsável e próxima ação_
>
> ⏭️ *Próxima Ação (3):*
> T-008 (Alexandre): Trocar lâmpadas do corredor → _Comprar lâmpadas_
> T-009 (Rafael): Backup do servidor → _Agendar janela de manutenção_
> T-010 (Laízes): Renovar contrato internet → _Ligar para operadora_
>
> 🔄 *Em Andamento (3):*
> T-001 (Alexandre): Instalar filtro → _Instalar amanhã_ ⏰ prazo sexta
> T-002 (Rafael): Câmeras SSP [2/5] → _Enviar dados do pessoal_
> T-004 (Laízes): Relatório mensal → _Consolidar dados de fevereiro_
>
> ⏳ *Aguardando (1):*
> T-006 (Rafael): Liberação firewall → _Esperando TI da SSP desde 20/02_
>
> 🔴 *Atrasadas (1):*
> T-003 (Alexandre): Consertar porta sala 2 — 3 dias de atraso!
>
> 🔁 *Recorrentes:*
> R-001 (Laízes): Pagamentos custeio — próximo ciclo: 05/03

### Para cada Subordinado (via send_message):

> 📋 *Bom dia, Rafael!*
>
> *Seu quadro hoje:*
> 🔄 T-002: Câmeras SSP → *Próxima ação: enviar dados do pessoal*
> ⏳ T-006: Firewall → Aguardando TI da SSP (5 dias)
> ⏭️ T-009: Backup servidor → *Pronto para iniciar*
>
> _WIP: 1/3 — você pode puxar mais uma tarefa._
> Alguma atualização?

---

## 6. Revisão Semanal (GTD)

Toda sexta-feira às 11:00, um scheduled task dedicado gera a revisão semanal — o ritual GTD de "limpar a mente e atualizar o sistema".

### O agente gera no grupo:

> 📋 *Revisão Semanal — Semana 24-28/02*
>
> *Resumo da semana:*
> Concluídas: 5 | Criadas: 3 | Atrasadas: 1
>
> *📥 Inbox para processar (2 itens):*
> T-012, T-013 — _precisam de responsável e próxima ação_
>
> *⏳ Aguardando há mais de 5 dias (1):*
> T-006 (Rafael) — Firewall SSP — _considerar follow-up?_
>
> *🔴 Atrasadas (1):*
> T-003 (Alexandre) — Porta sala 2 — _3 dias atrasada, reatribuir?_
>
> *🔄 Em andamento sem atualização há 3+ dias (1):*
> T-004 (Laízes) — Relatório mensal — _última atualização: terça_
>
> *📆 Próxima semana:*
> T-001 vence sexta | R-001 pagamentos dia 5/03
>
> _Ações sugeridas: processar inbox, follow-up aguardando, verificar atrasadas._

### Via send_message, cada subordinado recebe:

> 📋 *Revisão semanal — Rafael*
>
> *Concluídas esta semana:* T-005 (Firmware switches) ✅
> *Em andamento:* T-002 (Câmeras SSP) — etapa 2/5
> *Aguardando:* T-006 (Firewall) — 5 dias sem retorno da SSP
> *Próxima ação mais urgente:* Enviar dados do pessoal (T-002)
>
> Algo mudou? Precisa de ajuda com algum bloqueio?

---

## 7. Fluxos de Interação

### 7.1 Captura Rápida → Inbox

> @Andy anotar: pedir orçamento para pintura externa

Agente cria no Inbox (mínimo de fricção):
> 📥 T-013 adicionada ao Inbox: "Pedir orçamento para pintura externa"

### 7.2 Processar Inbox → Próxima Ação

> @Andy T-013 para Alexandre, prazo 15/03. Próxima ação: ligar para 3 empresas e pedir orçamento.

Agente move para "Próxima Ação":
> ⏭️ T-013 processada. Alexandre notificado.
> Próxima ação: _Ligar para 3 empresas e pedir orçamento_
> Lembretes agendados: 13/03 e 15/03.

### 7.3 Criar Tarefa Completa (atalho — pula Inbox)

Quando o gestor já sabe tudo, pode criar direto na coluna "Próxima Ação":

> @Andy tarefa para Alexandre: receber e instalar o filtro até sexta. Próxima ação: confirmar horário de entrega com fornecedor.

### 7.4 Puxar Tarefa (Pull — Kanban)

O responsável indica que vai começar:

> @Andy começando T-008

Agente move para "Em Andamento" (se WIP permite):
> 🔄 T-008 movida para Em Andamento. Alexandre agora tem 2/3 tarefas ativas.

Se WIP estourado:
> ⚠️ Alexandre já tem 3 tarefas em andamento (T-001, T-003, T-004). Concluir ou pausar uma antes de iniciar T-008.

### 7.5 Mover para Aguardando

> @Andy T-002 aguardando resposta da SSP sobre a VPN

Agente atualiza:
> ⏳ T-002 movida para Aguardando. Motivo: _resposta da SSP sobre VPN_
> Liberou 1 slot de WIP. Rafael agora tem 1/3 ativas.

### 7.6 Atualizar Próxima Ação

A qualquer momento, o responsável ou gestor pode redefinir:

> @Andy próxima ação T-002: configurar VPN após receber credenciais

O campo `next_action` é atualizado. Isso aparece no próximo digest.

### 7.7 Concluir

> @Andy T-001 concluída

Agente:
1. Move para "Concluído", limpa scheduled tasks
2. Pergunta se o responsável quer puxar a próxima:
   > ✅ T-001 concluída! Alexandre agora tem 1/3 ativas.
   > ⏭️ Na fila: T-008 (Trocar lâmpadas). Quer iniciar?

### 7.8 Projeto com Subtarefas

> @Andy projeto para Rafael: acesso câmeras SSP. Etapas: alinhar com SSP, enviar dados, obter liberação, configurar acessos, treinar pessoal. Prazo 15/03.

O `next_action` do projeto é sempre derivado da primeira subtarefa pendente:
```json
{
  "next_action": "Alinhar requisitos técnicos com a SSP (T-002.1)"
}
```

Quando T-002.1 conclui, o agente atualiza automaticamente:
```json
{
  "next_action": "Enviar dados de quem vai acessar (T-002.2)"
}
```

### 7.9 Recorrente

Igual à versão anterior, mas com o campo `next_action` atualizado a cada ciclo:

```json
{
  "next_action": "Efetuar pagamentos do ciclo de março (vencem dia 5)"
}
```

---

## 8. Comandos (Linguagem Natural)

### Captura e Processamento (GTD)

| Intenção | Exemplos |
|---|---|
| Captura rápida | "anotar: verificar ar condicionado" |
| Processar inbox | "processar inbox" / "o que tem no inbox?" |
| Definir responsável | "T-012 para Alexandre, prazo sexta" |
| Definir próxima ação | "próxima ação T-012: verificar e reportar" |

### Movimento no Quadro (Kanban)

| Intenção | Exemplos |
|---|---|
| Iniciar (pull) | "começando T-008" / "iniciando T-008" |
| Aguardando | "T-002 aguardando resposta da SSP" |
| Retomar | "T-002 retomada, recebi resposta" |
| Concluir | "T-001 concluída" / "T-001 feita" |
| Cancelar | "cancelar T-005" |

### Gestão

| Intenção | Exemplos |
|---|---|
| Ver quadro | "como está o quadro?" / "status geral" |
| Tarefas de alguém | "quadro do Rafael" / "o que o Rafael tem?" |
| Inbox pendente | "o que tem no inbox?" |
| Aguardando há muito | "o que está aguardando há mais de 3 dias?" |
| Atrasadas | "tarefas atrasadas" |
| Alterar prazo | "estender prazo T-002 para 30/03" |
| Reatribuir | "passar T-001 para Rafael" |
| Alterar WIP | "aumentar limite do Alexandre para 4" |
| Criar projeto | "projeto para Rafael: câmeras SSP..." |
| Criar recorrente | "mensal para Laízes: pagamentos dia 5" |
| Adicionar subtarefa | "adicionar etapa na T-002: configurar VPN" |

---

## 9. Fluxo de Dados Completo

```
┌─────────────────────────────────────────────────────────────────┐
│                     GESTOR (Miguel)                             │
│  "@Andy tarefa para Alexandre: instalar filtro até sexta.       │
│   Próxima ação: confirmar entrega com fornecedor."              │
└───────────────────────┬─────────────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              Container (Claude Agent SDK)                       │
│                                                                 │
│  1. Lê CLAUDE.md → carrega quadro Kanban                       │
│  2. Interpreta: criar tarefa, assignee, prazo, next_action     │
│  3. Verifica WIP do Alexandre (ok, 2/3)                        │
│  4. Cria T-007 com status "next_action"                        │
│  5. Atualiza CLAUDE.md                                         │
│  6. IPC send_message → Alexandre (notificação + próxima ação)  │
│  7. IPC schedule_task × 2 → lembretes (once)                  │
│  8. Responde no grupo com confirmação                          │
└───────────────────────┬─────────────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│    task-scheduler.ts (polling 60s) — executa automaticamente   │
│                                                                 │
│  Seg-Sex 08:00 → daily digest (quadro Kanban + digest pessoal) │
│  Sexta 11:00 → revisão semanal (GTD review)                   │
│  2d antes prazo → lembrete (once, auto-limpa)                  │
│  Dia do prazo → cobrança (once, auto-limpa)                    │
│  Recorrência → ciclo completo (crons permanentes)              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Cenário Completo: Uma Semana

```
SEGUNDA 08:00 — Daily Digest automático (cron)
  → Grupo: quadro Kanban com inbox, próximas ações, andamento, aguardando
  → send_message individual para cada pessoa com seu quadro e WIP

SEGUNDA 09:00 — Gestor captura rápido
  "anotar: verificar situação do gerador"
  → T-015 vai para Inbox

SEGUNDA 09:15 — Gestor processa inbox
  "T-015 para Alexandre, prazo quarta. Próxima ação: verificar e reportar"
  → T-015 move para ⏭️ Próxima Ação
  → Alexandre notificado via send_message
  → schedule_task (once) para lembrete terça

SEGUNDA 10:00 — Alexandre puxa tarefa
  "começando T-015"
  → T-015 move para 🔄 Em Andamento (WIP: 3/3)

SEGUNDA 14:00 — Alexandre conclui outra
  "T-008 concluída"
  → T-008 move para ✅ Concluído (WIP: 2/3)
  → Agente: "Quer iniciar a próxima da fila?"

TERÇA 08:00 — Daily Digest
  → Quadro atualizado: T-015 em andamento, T-008 concluída ontem

TERÇA 08:00 — Lembrete automático (scheduled task once)
  → send_message → Alexandre: "⏰ T-015 vence amanhã"

TERÇA 11:00 — Rafael reporta bloqueio
  "T-002 aguardando a SSP mandar as credenciais da VPN"
  → T-002 move para ⏳ Aguardando (WIP: liberou 1 slot)
  → Gestor vê no grupo: "⏳ T-002 aguardando SSP (credenciais VPN)"

QUARTA 15:00 — Alexandre conclui
  "T-015 feita, gerador funcionando normal"
  → ✅ Concluído, scheduled tasks limpos

QUINTA 10:00 — Gestor cria projeto
  "projeto para Rafael: sistema de câmeras SSP..."
  → Projeto criado com subtarefas, next_action da primeira etapa
  → Rafael notificado com detalhamento

SEXTA 11:00 — Revisão Semanal automática (cron)
  → Análise completa: concluídas, inbox pendente, aguardando há muito,
    atrasadas, próxima semana
  → Cada pessoa recebe resumo individual da semana
```

---

## 11. Plano de Implementação

### Fase 1: Fundação (Semana 1)

1. Fork do NanoClaw, `/setup`
2. Criar skill e grupo "Gestão de Tarefas"
3. CLAUDE.md com modelo Kanban+GTD
4. Cadastro de pessoas com WIP limit
5. Captura rápida (inbox) e criação de tarefas simples
6. Notificação via `send_message`

### Fase 2: Fluxo Kanban (Semana 2)

1. Movimentação no quadro (pull, aguardando, concluir)
2. Verificação de WIP limit
3. Daily digest como quadro Kanban (cron via `schedule_task`)
4. Lembretes de prazo (once via `schedule_task`)

### Fase 3: GTD Completo (Semana 3)

1. Processamento de inbox com definição de próxima ação
2. Revisão semanal (cron sexta 11:00)
3. Projetos com subtarefas e próxima ação derivada
4. Recorrentes com checklist

### Fase 4: Refinamento (Semana 4)

1. Ajustar WIP limits por pessoa
2. Otimizar prompts dos scheduled tasks
3. Edge cases (pessoa não responde, tarefa sem prazo)
4. Backup do CLAUDE.md (cron semanal)

---

## 12. Considerações Técnicas

### Simplicidade do Modelo

O Kanban+GTD adicionam apenas 3 campos ao modelo anterior:
- `next_action` (string) — a ação concreta e imediata
- `waiting_for` (string, opcional) — de quem/o quê se espera
- `wip_limit` (número, por pessoa) — limite de WIP

Os estados mudaram de nomes mas continuam sendo um único campo `status`. Não há complexidade adicional no scheduler ou na infraestrutura.

### CLAUDE.md e Contexto

O formato do quadro Kanban no CLAUDE.md é naturalmente mais organizado — tarefas agrupadas por coluna são mais fáceis para o agente interpretar do que uma lista flat.

### Issue #293 — Scheduled Tasks Bloqueadas

Mesmo risco da versão anterior. Mitigações: reduzir `IDLE_TIMEOUT`, aplicar fix da issue.

### Timezone

Teresina/Fortaleza: UTC-3, sem horário de verão. 08:00 local = 11:00 UTC.
Daily digest: `"0 11 * * 1-5"` (seg-sex). Revisão semanal: `"0 14 * * 5"` (sexta 11:00 BRT).

---

## 13. Evolução Futura

- **Métricas Kanban**: Lead time, cycle time, throughput por pessoa/semana
- **Dashboard HTML**: Quadro visual gerado periodicamente
- **Dependências**: Subtarefa X só libera quando Y concluir
- **Priorização**: Urgente/Importante (Eisenhower) como tag opcional
- **Agent Swarms**: Múltiplos agentes para digest + cobranças em paralelo
- **Anexos**: Fotos de comprovantes, documentos
