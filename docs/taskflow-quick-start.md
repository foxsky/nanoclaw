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

### 3. Agende uma reuniao

```
@Case reuniao: alinhamento semanal amanha as 14h
```

A reuniao recebe ID `MXXX`, fica em Proxima Acao e depois pode ganhar pauta, ata e participantes.

### 4. Veja o quadro

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
Responsavel comeca       →  @Case comecando T001
Fica bloqueado           →  @Case T001 aguardando aprovacao juridica
Desbloqueou              →  @Case T001 retomada
Finalizou                →  @Case T001 pronta para revisao
Gestor aprova            →  @Case T001 aprovada
```

---

## Comandos Essenciais

### Captura Rapida (todos)

```
@Case anotar: [descricao]
@Case lembrar: [descricao]
@Case nova tarefa: [descricao]
@Case tarefa: [descricao]
```

Se usar "tarefa" sem indicar responsavel (sem "para [pessoa]"), vai para o Inbox como captura rapida.

### Mover Tarefas

| Comando | O que faz |
|---------|-----------|
| `@Case comecando TXXX` | Comeca a trabalhar (verifica limite WIP) |
| `@Case TXXX aguardando [motivo]` | Marca como bloqueada |
| `@Case TXXX retomada` | Volta a trabalhar |
| `@Case TXXX pronta para revisao` | Envia para revisao do gestor |
| `@Case TXXX aprovada` | Aprova e conclui (gestor) |
| `@Case devolver TXXX` | Devolve para Proxima Acao (libera WIP) |
| `@Case TXXX concluida` | Atalho direto para concluida |
| `@Case reabrir TXXX` | Reabre uma tarefa concluida |
| `@Case desfazer` | Desfaz ultima acao (ate 60s) |

### Consultas

| Comando | O que mostra |
|---------|-------------|
| `@Case quadro` | Quadro completo |
| `@Case minhas tarefas` | Suas tarefas |
| `@Case atrasadas` | Tarefas com prazo vencido |
| `@Case vencem hoje` | Prazos de hoje |
| `@Case buscar [texto]` | Busca por palavra |
| `@Case reunioes` | Lista reunioes abertas |
| `@Case proximas reunioes` | Reunioes agendadas para frente |
| `@Case pauta MXXX` | Mostra a pauta da reuniao |
| `@Case ata MXXX` | Mostra a ata/notas da reuniao |
| `@Case participantes MXXX` | Mostra organizador e participantes |
| `@Case resumo` | Resumo executivo |
| `@Case resumo semanal` | Revisao semanal sob demanda |
| `@Case estatisticas` | Metricas do quadro |
| `@Case ajuda` | Resumo curto de comandos |
| `@Case manual` | Referência completa detalhada |
| `@Case guia rapido` | Guia para iniciantes |

### Criar Tarefas com Responsavel (gestor)

```
@Case tarefa para [pessoa]: [descricao] ate [data]
@Case projeto para [pessoa]: [descricao]. Etapas: 1. ..., 2. ...
@Case diario para [pessoa]: [descricao]
@Case semanal para [pessoa]: [descricao] toda segunda
@Case mensal para [pessoa]: [descricao] todo dia [N]
```

### Reunioes

```
@Case reuniao: [titulo] em [data] as [hora]
@Case reuniao com [pessoa], [pessoa]: [titulo] em [data] as [hora]
@Case pauta MXXX: [texto]
@Case ata MXXX: [texto]
@Case reagendar MXXX para [data] as [hora]
```

### Reatribuir (responsavel ou gestor)

| Comando | O que faz |
|---------|-----------|
| `@Case reatribuir TXXX para [pessoa]` | Muda responsavel (pede confirmacao) |

### Gestao (gestor)

| Comando | O que faz |
|---------|-----------|
| `@Case processar inbox` | Processa itens pendentes |
| `@Case estender prazo TXXX para [data]` | Altera prazo |
| `@Case cancelar TXXX` | Cancela e arquiva |
| `@Case T005, T006, T007 aprovadas` | Operacoes em lote |

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

- **TN** — Tarefa simples
- **PN** — Projeto com sub-etapas (P1.1, P1.2, ...)
- **RN** — Recorrente (gera nova instancia ao concluir)
- **M** — Reuniao com horario, pauta, ata e participantes (`M001`, `M002`, ...)

---

## Permissoes

| Quem | O que pode |
|------|-----------|
| **Todos** | Captura rapida, consultas, busca, ajuda, criar reunioes |
| **Responsavel** | Mover suas tarefas, adicionar notas, reatribuir suas tarefas |
| **Delegado** | Processar inbox, aprovar/rejeitar revisao |
| **Gestor** | Criar tarefas completas, cancelar, reatribuir qualquer tarefa, configurar equipe |

---

## Dicas

- Datas: use `hoje`, `amanha`, `sexta`, `15/03` ou `proxima segunda`
- Prioridade: `@Case prioridade TXXX: urgente` (baixa, normal, alta, urgente)
- Rotulos: `@Case rotulo TXXX: financeiro` para agrupar tarefas
- Notas: `@Case nota TXXX: cliente pediu ajuste` para comentar
- Dependencias: `@Case T001 depende de T002`
- Descricao: `@Case descricao TXXX: escopo detalhado da tarefa`
- Lembretes: `@Case lembrete TXXX 3 dias antes`
- Pauta: `@Case pauta MXXX` consulta a agenda; `@Case pauta MXXX: texto` adiciona item
- Ata: `@Case ata MXXX` mostra as notas; `@Case ata MXXX: texto` adiciona registro da reuniao
- Reunioes nao contam no limite WIP e usam `MXXX` como prefixo

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
| `@Case vincular TXXX ao quadro do [pessoa]` | Vincula tarefa ao quadro filho |
| `@Case desvincular TXXX` | Remove vinculo |
| `@Case atualizar status TXXX` | Atualiza rollup do quadro filho |
| `@Case resumo de execucao TXXX` | Mostra resumo do rollup |
| `@Case ligar tarefa ao pai TXXX` | Marca tarefa como parte de entrega do nivel acima |

Tarefas vinculadas aparecem com 🔗 no quadro. O rollup mostra o status agregado do quadro filho (ativo, bloqueado, em risco, pronto para revisao).

Atribuir e vincular sao a mesma operacao — ao reatribuir uma tarefa vinculada, o vinculo e transferido automaticamente para o quadro da nova pessoa.

Se o quadro pai so precisa destravar uma tarefa vinculada, nao reatribua por padrao. Prefira:

- `@Case proxima acao TXXX: Miguel aprovar orçamento`
- `@Case TXXX aguardando Miguel aprovar orçamento` somente se a tarefa ja estiver em andamento

Assim a tarefa continua no quadro filho, mas fica claro que a proxima dependencia esta no quadro pai. `Devolver` continua sendo voltar para Proxima Acao, nao voltar para o quadro pai. Reatribua apenas quando a propriedade da mesma tarefa realmente precisar voltar para o quadro pai. Hoje isso normalmente e feito no quadro pai ou no grupo de controle, porque a resolucao de pessoas e local ao quadro atual. Se o gestor precisar de um trabalho separado, crie outra tarefa no quadro pai ou no grupo de controle.

Para mais informações, envie `@Case manual` (referência completa) ou `@Case guia rapido` (guia para iniciantes) no grupo.
