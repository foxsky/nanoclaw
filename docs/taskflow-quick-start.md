# TaskFlow — Guia Rapido

Gerencie tarefas da sua equipe pelo WhatsApp. Tudo acontece no grupo — basta enviar mensagens para `@Case`.

## Primeiros Passos

### 1. Capture uma ideia

```
@Case anotar: revisar contrato do fornecedor
```

A tarefa vai para o Inbox. Qualquer pessoa do grupo pode usar esse comando.

### 2. Crie uma tarefa completa (gestor)

```
@Case tarefa para Alexandre: revisar contrato ate sexta
```

A tarefa vai direto para Proxima Acao, com responsavel e prazo.

### 3. Veja o quadro

```
@Case quadro
```

Mostra todas as tarefas organizadas por coluna.

---

## O Quadro

Cada tarefa esta em uma coluna:

```
📥 Inbox → ⏭️ Proxima Acao → 🔄 Em Andamento → ⏳ Aguardando → 👁️ Revisao → ✅ Concluida
```

O fluxo tipico:

```
Gestor cria tarefa       →  @Case tarefa para Alexandre: X ate sexta
Responsavel comeca       →  @Case comecando T-001
Fica bloqueado           →  @Case T-001 aguardando aprovacao juridica
Desbloqueou              →  @Case T-001 retomada
Finalizou                →  @Case T-001 pronta para revisao
Gestor aprova            →  @Case T-001 aprovada
```

---

## Comandos Essenciais

### Captura Rapida (todos)

```
@Case anotar: [descricao]
@Case lembrar: [descricao]
```

### Mover Tarefas

| Comando | O que faz |
|---------|-----------|
| `@Case comecando T-XXX` | Comeca a trabalhar (verifica limite WIP) |
| `@Case T-XXX aguardando [motivo]` | Marca como bloqueada |
| `@Case T-XXX retomada` | Volta a trabalhar |
| `@Case T-XXX pronta para revisao` | Envia para revisao do gestor |
| `@Case T-XXX aprovada` | Aprova e conclui (gestor) |
| `@Case devolver T-XXX` | Devolve para Proxima Acao (libera WIP) |
| `@Case T-XXX concluida` | Atalho direto para concluida |
| `@Case reabrir T-XXX` | Reabre uma tarefa concluida |
| `@Case desfazer` | Desfaz ultima acao (ate 60s) |

### Consultas

| Comando | O que mostra |
|---------|-------------|
| `@Case quadro` | Quadro completo |
| `@Case minhas tarefas` | Suas tarefas |
| `@Case atrasadas` | Tarefas com prazo vencido |
| `@Case vencem hoje` | Prazos de hoje |
| `@Case buscar [texto]` | Busca por palavra |
| `@Case resumo` | Resumo executivo |
| `@Case resumo semanal` | Revisao semanal sob demanda |
| `@Case estatisticas` | Metricas do quadro |
| `@Case ajuda` | Lista completa de comandos |

### Criar Tarefas (gestor)

```
@Case tarefa para [pessoa]: [descricao] ate [data]
@Case projeto para [pessoa]: [descricao]. Etapas: 1. ..., 2. ...
@Case diario para [pessoa]: [descricao]
@Case semanal para [pessoa]: [descricao] toda segunda
@Case mensal para [pessoa]: [descricao] todo dia [N]
```

### Reatribuir (responsavel ou gestor)

| Comando | O que faz |
|---------|-----------|
| `@Case reatribuir T-XXX para [pessoa]` | Muda responsavel (pede confirmacao) |

### Gestao (gestor)

| Comando | O que faz |
|---------|-----------|
| `@Case processar inbox` | Processa itens pendentes |
| `@Case estender prazo T-XXX para [data]` | Altera prazo |
| `@Case cancelar T-XXX` | Cancela e arquiva |
| `@Case T-005, T-006, T-007 aprovadas` | Operacoes em lote |

---

## Automacoes

O TaskFlow envia automaticamente:

- **Standup matinal** — quadro completo com destaques
- **Resumo noturno** — tarefas atrasadas, bloqueadas e concluidas
- **Revisao semanal** — balanco GTD completo (sexta)

Nao precisa configurar nada — ja vem pronto na instalacao. Quando o grupo de controle esta ativado, cada automacao pode ser direcionada para o grupo da equipe, o grupo de controle ou ambos.

---

## Grupo de Controle (Opcional)

Na instalacao, o gestor pode ativar um grupo de controle privado. Ambos os grupos compartilham o mesmo quadro — o gestor gerencia de um grupo privado enquanto a equipe trabalha no grupo principal.

Comandos como `processar inbox`, `reatribuir`, `cancelar` e `estatisticas` funcionam normalmente no grupo de controle — a unica diferenca e que as mensagens ficam no grupo privado e nao aparecem para a equipe.

---

## Tipos de Tarefa

- **T-NNN** — Tarefa simples
- **P-NNN** — Projeto com sub-etapas (P-001.1, P-001.2, ...)
- **R-NNN** — Recorrente (gera nova instancia ao concluir)

---

## Permissoes

| Quem | O que pode |
|------|-----------|
| **Todos** | Captura rapida, consultas, busca, ajuda |
| **Responsavel** | Mover suas tarefas, adicionar notas, reatribuir suas tarefas |
| **Delegado** | Processar inbox, aprovar/rejeitar revisao |
| **Gestor** | Tudo: criar, cancelar, reatribuir qualquer tarefa, configurar equipe |

---

## Dicas

- Datas: use `hoje`, `amanha`, `sexta`, `15/03` ou `proxima segunda`
- Prioridade: `@Case prioridade T-XXX: urgente` (baixa, normal, alta, urgente)
- Rotulos: `@Case rotulo T-XXX: financeiro` para agrupar tarefas
- Notas: `@Case nota T-XXX: cliente pediu ajuste` para comentar
- Dependencias: `@Case T-001 depende de T-002`
- Descricao: `@Case descricao T-XXX: escopo detalhado da tarefa`
- Lembretes: `@Case lembrete T-XXX 3 dias antes`

---

## Hierarquia (Delegacao)

O TaskFlow pode organizar quadros em niveis. O gestor raiz delega para pessoas que gerenciam seus proprios quadros.

### Criar quadros filhos

Quadros filhos sao criados automaticamente:

- **Ao cadastrar**: `@Case cadastrar Joao, telefone 5585999990000, desenvolvedor` — em quadros nao-folha, cria o quadro filho automaticamente.
- **Ao atribuir a pessoa desconhecida**: `@Case tarefa para Joao: revisar contrato` — o assistente oferece cadastrar. Se o gestor confirmar com telefone e cargo, o cadastro e o quadro sao criados, e a tarefa e atribuida em seguida.
- **Solicitacao explicita**: `@Case criar quadro para [pessoa]`

### Comandos de hierarquia

| Comando | O que faz |
|---------|-----------|
| `@Case vincular T-XXX ao quadro do [pessoa]` | Vincula tarefa ao quadro filho |
| `@Case desvincular T-XXX` | Remove vinculo |
| `@Case atualizar status T-XXX` | Atualiza rollup do quadro filho |
| `@Case resumo de execucao T-XXX` | Mostra resumo do rollup |
| `@Case ligar tarefa ao pai T-XXX` | Marca tarefa como parte de entrega do nivel acima |

Tarefas vinculadas aparecem com 🔗 no quadro. O rollup mostra o status agregado do quadro filho (ativo, bloqueado, em risco, pronto para revisao).

Atribuir e vincular sao a mesma operacao — ao reatribuir uma tarefa vinculada, o vinculo e transferido automaticamente para o quadro da nova pessoa.

Para o manual completo, envie `@Case manual` no grupo.
