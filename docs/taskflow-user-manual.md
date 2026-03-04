# TaskFlow — Manual do Usuário

Guia de uso do TaskFlow, o assistente de gestão de tarefas via WhatsApp.

## Como Funciona

O TaskFlow gerencia suas tarefas usando um quadro Kanban com 6 colunas. Toda interação acontece pelo WhatsApp — basta enviar mensagens no grupo.

**Para acionar o assistente**, comece a mensagem com `@Case` (ou o nome configurado do assistente).

## Configuração Inicial

Na instalação, o gestor define:

- O nome de ativação do assistente (ex.: `@Case`)
- O idioma das respostas
- O fuso horário usado pelas automações
- O modelo de IA usado pelo assistente do grupo
- O limite WIP padrão da equipe
- Os horários do standup, resumo e revisão semanal

O TaskFlow sempre tem pelo menos um **gestor de referência** (o primeiro gestor registrado). Também pode ter:

- **Gestores adicionais**: têm o mesmo poder administrativo do gestor de referência
- **Delegados**: podem processar Inbox e aprovar/rejeitar Revisão, mas não alteram equipe, configuração ou papéis administrativos

### Um Grupo ou Vários

O TaskFlow pode ser usado de duas formas:

- **Um grupo compartilhado**: um único quadro para toda a equipe
- **Grupos separados**: cada grupo tem seu próprio quadro, com tarefas, automações e histórico independentes

Se houver mais de um grupo, **não existe sincronização automática entre eles**. Cada grupo é tratado como um quadro separado.

## O Quadro

Cada tarefa está em exatamente uma coluna:

```
📥 Inbox → ⏭️ Próxima Ação → 🔄 Em Andamento → ⏳ Aguardando → 👁️ Revisão → ✅ Concluída
```

| Coluna | Significado |
|--------|-------------|
| 📥 Inbox | Captura rápida, sem detalhes. Gestor processa depois. |
| ⏭️ Próxima Ação | Pronta para executar. Tem responsável e próxima ação definidos. |
| 🔄 Em Andamento | Sendo executada ativamente. Conta no limite WIP. |
| ⏳ Aguardando | Bloqueada por terceiro. Registra quem/o quê está sendo esperado. |
| 👁️ Revisão | Executor finalizou. Gestor aprova para concluir. |
| ✅ Concluída | Aprovada e finalizada. Arquivada automaticamente após 30 dias. |

### Limite WIP (Work In Progress)

Cada pessoa tem um limite de tarefas simultâneas em "Em Andamento" (padrão: 3). Se o limite for atingido, o assistente avisa e não permite mover mais tarefas para andamento até que uma seja concluída ou mova para aguardando.

O gestor pode forçar com: `@Case forcar T-XXX para andamento`

### Tipos de Tarefa

- **T-NNN** — Tarefa simples (ação única)
- **P-NNN** — Projeto (tem sub-etapas). Cada etapa vira uma sub-tarefa (`P-001.1`, `P-001.2`, etc.)
- **R-NNN** — Recorrente (repete por agenda). Gera automaticamente uma nova instância após conclusão.

Todos os comandos de movimentação funcionam com qualquer prefixo (`T-`, `P-`, `R-`).

Toda tarefa nova nasce com prioridade `normal` e sem rótulos. Depois, o gestor ou o responsável podem ajustar isso.

---

## Comandos

### Captura Rápida

Quando você quer registrar algo rapidamente, sem detalhes:

```
@Case anotar: revisar contrato do fornecedor
@Case lembrar: ligar para o cliente amanhã
@Case registrar: comprar material de escritório
```

O assistente cria a tarefa no Inbox e responde: `📥 T-001 adicionada ao Inbox`

### Criar Tarefa Completa

Se já tem responsável e prazo, a tarefa vai direto para Próxima Ação:

Somente um gestor pode usar os comandos de criação completa (`tarefa`, `projeto`, `diario`, `semanal`, `mensal`, `anual`).

```
@Case tarefa para Alexandre: revisar contrato ate sexta
@Case tarefa para Rafael: configurar servidor ate 15/03
```

### Criar Projeto (com etapas)

```
@Case projeto para Alexandre: migração do servidor. Etapas: 1. backup dos dados, 2. instalar novo SO, 3. migrar serviços, 4. testes
```

Projetos também podem ser recorrentes. As etapas são reiniciadas automaticamente a cada ciclo:

```
@Case projeto recorrente para Alexandre: revisão de infraestrutura. Etapas: 1. backup, 2. atualização, 3. testes. todo mensal
```

### Criar Tarefa Recorrente

```
@Case diario para Alexandre: verificar emails
@Case semanal para Rafael: backup do servidor toda segunda
@Case mensal para Laizes: relatório financeiro todo dia 5
@Case anual para Alexandre: renovar licenças todo dia 15/01
```

---

### Mover Tarefas no Quadro

| Comando | O que faz |
|---------|-----------|
| `@Case comecando T-001` | Move para Em Andamento (verifica WIP) |
| `@Case iniciando T-001` | Mesmo que acima |
| `@Case T-001 aguardando resposta do fornecedor` | Move para Aguardando |
| `@Case T-001 retomada` | Volta para Em Andamento (verifica WIP) |
| `@Case devolver T-001` | Devolve de Em Andamento para Próxima Ação (libera WIP) |
| `@Case T-001 pronta para revisao` | Move para Revisão |
| `@Case T-001 aprovada` | Move de Revisão para Concluída (gestor ou delegado) |
| `@Case T-001 rejeitada: ajustar item X` | Devolve de Revisão para Em Andamento com motivo de retrabalho (gestor ou delegado) |
| `@Case reabrir T-001` | Reabre uma tarefa concluída e devolve para Próxima Ação |
| `@Case T-001 concluida` | Atalho: move direto para Concluída (responsável ou gestor) |
| `@Case T-001 feita` | Mesmo que acima |
| `@Case forcar T-001 para andamento` | Move para Em Andamento ignorando limite WIP (gestor) |
| `@Case adicionar etapa P-001: validar rollback` | Adiciona uma nova sub-etapa ao final do projeto |
| `@Case renomear etapa P-001.2: instalar SO atualizado` | Renomeia uma sub-etapa específica do projeto |
| `@Case reabrir etapa P-001.2` | Reabre uma sub-etapa concluída e recalcula a próxima ação |
| `@Case P-001.1 concluida` | Marca sub-etapa do projeto como feita e avança a próxima ação |
| `@Case reatribuir T-001 para Rafael` | Muda o responsável da tarefa (responsável ou gestor, pede confirmação) |
| `@Case cancelar T-001` | Cancela e arquiva (gestor, pede confirmação) |
| `@Case restaurar T-001` | Restaura uma tarefa arquivada para Próxima Ação (gestor) |

### Operações em Lote

Você pode aplicar ações a várias tarefas de uma vez usando IDs separados por vírgula:

```
@Case T-005, T-006, T-007 aprovadas
@Case aprovar T-005, T-006, T-007
```

Funciona com: aprovar, rejeitar, concluir, cancelar. Cada tarefa é processada individualmente (mesma permissão e validação). O resultado mostra o status de cada uma.

### Desfazer

Desfaça a última ação em até 60 segundos:

```
@Case desfazer
```

Limitações: não desfaz criação (use `cancelar`), arquivamento, avanço de recorrência ou operações em lote. Apenas um nível de desfazer (sem cadeia). Efeitos cascata (dependências resolvidas, lembretes cancelados) não são revertidos.

### Fluxo Típico

```
1. Gestor cria tarefa     → @Case tarefa para Alexandre: revisar contrato ate sexta
2. Responsável começa     → @Case comecando T-001
3. Fica bloqueado         → @Case T-001 aguardando aprovação jurídica
4. Desbloqueou            → @Case T-001 retomada
5. Finalizou              → @Case T-001 pronta para revisao
6. Gestor aprova          → @Case T-001 aprovada
```

---

### Consultas

| Comando | O que mostra |
|---------|-------------|
| `@Case quadro` | Quadro completo com todas as colunas |
| `@Case status` | Mesmo que quadro |
| `@Case como esta?` | Mesmo que quadro |
| `@Case quadro do Alexandre` | Tarefas de uma pessoa específica |
| `@Case inbox` | Somente itens no Inbox |
| `@Case revisao` | Somente tarefas em Revisão |
| `@Case revisao do Alexandre` | Somente tarefas em Revisão de uma pessoa |
| `@Case proxima acao` | Somente tarefas em Próxima Ação |
| `@Case em andamento` | Somente tarefas em Em Andamento |
| `@Case minhas tarefas` | Suas próprias tarefas (identifica pelo remetente) |
| `@Case detalhes T-001` | Todos os campos da tarefa, notas e últimas 5 ações do histórico |
| `@Case historico T-001` | Histórico completo da tarefa |
| `@Case atrasadas` | Tarefas com prazo vencido |
| `@Case vencem hoje` | Tarefas com prazo para hoje |
| `@Case vencem amanha` | Tarefas com prazo para amanhã |
| `@Case vencem esta semana` | Tarefas com prazo até o fim da semana atual |
| `@Case proximos 7 dias` | Tarefas com prazo nos próximos 7 dias |
| `@Case buscar contrato` | Busca texto em título, próxima ação, aguardando e notas |
| `@Case buscar contrato com rotulo financeiro` | Busca texto, mas somente em tarefas com um rótulo específico |
| `@Case urgentes` | Somente tarefas com prioridade urgente |
| `@Case prioridade alta` | Somente tarefas com prioridade alta |
| `@Case rotulo financeiro` | Somente tarefas com um rótulo específico |
| `@Case buscar rotulo financeiro` | Mesmo filtro por rótulo, com uma forma mais explícita |
| `@Case concluidas hoje` | Tarefas concluídas hoje |
| `@Case concluidas esta semana` | Tarefas concluídas na semana atual |
| `@Case o que esta aguardando?` | Tarefas bloqueadas |
| `@Case aguardando do Alexandre` | Somente tarefas bloqueadas de uma pessoa |
| `@Case concluidas do Alexandre` | Tarefas concluídas de uma pessoa específica |
| `@Case concluidas do mes` / `concluidas este mes` | Tarefas concluídas no mês atual |
| `@Case resumo` | Resumo sob demanda (formato do resumo do gestor) |
| `@Case listar arquivo` | 20 tarefas arquivadas mais recentes |
| `@Case buscar no arquivo contrato` | Busca no arquivo por texto |
| `@Case agenda` | Agenda dos próximos 14 dias por prazo |
| `@Case agenda da semana` | Agenda dos próximos 7 dias |
| `@Case o que mudou hoje?` | Mudanças feitas hoje (timeline) |
| `@Case o que mudou desde ontem?` | Mudanças desde ontem |
| `@Case o que mudou esta semana?` | Mudanças da semana atual |
| `@Case estatisticas` | Estatísticas do quadro (concluídas, tempo médio, tendência) |
| `@Case estatisticas do Alexandre` | Estatísticas de uma pessoa |
| `@Case estatisticas do mes` | Estatísticas do mês atual |
| `@Case ajuda` | Lista de comandos disponíveis |

### Estatísticas

Veja métricas do quadro:

```
@Case estatisticas
@Case estatisticas do Alexandre
@Case estatisticas do mes
```

Inclui: concluídas na semana/mês, tempo médio de ciclo (criação→conclusão), tendência de produtividade (esta semana vs anterior) e detalhamento por pessoa. Usa dados do quadro ativo e do arquivo (até 90 dias).

---

### Processar Inbox

Um gestor ou delegado pode processar itens pendentes no Inbox:

```
@Case processar inbox
```

O assistente lista cada item e pergunta: responsável, prazo e próxima ação. Após preencher, a tarefa vai para Próxima Ação.

Também pode processar um item específico (gestor ou delegado):

```
@Case T-001 para Alexandre, prazo sexta
```

### Atualizar Tarefa

```
@Case proxima acao T-001: enviar email para o cliente
@Case renomear T-001: título corrigido
@Case prioridade T-001: alta
@Case rotulo T-001: financeiro
@Case remover rotulo T-001: financeiro
@Case nota T-001: cliente pediu ajuste no item 3
@Case editar nota T-001 #1: cliente pediu ajuste no item 4
@Case remover nota T-001 #1
@Case descricao T-001: texto da descrição
```

A descrição é um texto livre de até 500 caracteres que detalha o escopo da tarefa. Diferente das notas, cada tarefa tem apenas uma descrição. Para alterar, envie o comando novamente com o novo texto.

As notas funcionam como comentários da tarefa: o assistente registra automaticamente um ID (`#1`, `#2`, ...), o texto, quem enviou e quando foi registrado.

Notas novas podem ser editadas e removidas pelo gestor ou pelo responsável:

- `@Case editar nota T-001 #2: novo texto`
- `@Case remover nota T-001 #2`

Notas antigas de quadros muito antigos podem aparecer sem ID. Elas continuam visíveis, mas não podem ser editadas.

Prioridades aceitas: `baixa`, `normal`, `alta`, `urgente`.

Rótulos são palavras curtas para agrupar tarefas, como `financeiro`, `cliente-a`, `infra`.

### Dependências

Você pode marcar que uma tarefa depende de outra. As dependências são informativas — não bloqueiam movimentação.

| Comando | O que faz |
|---------|-----------|
| `@Case T-001 depende de T-002` | Marca que T-001 depende de T-002 |
| `@Case remover dependencia T-001 de T-002` | Remove a dependência |

Quando uma tarefa bloqueadora é concluída, a dependência é removida automaticamente e o grupo é notificado.

Se você cancelar uma tarefa que bloqueia outras, o assistente avisa antes da confirmação quais tarefas serão destravadas. Depois da confirmação, ele remove essa dependência das tarefas afetadas e avisa o grupo.

O assistente verifica dependências circulares antes de adicionar (ex: se T-002 já depende de T-001, recusa).

### Lembretes de Prazo

Crie lembretes para receber uma notificação N dias antes do prazo:

| Comando | O que faz |
|---------|-----------|
| `@Case lembrete T-001 3 dias antes` | Cria lembrete 3 dias antes do prazo |
| `@Case remover lembrete T-001` | Remove todos os lembretes da tarefa |

A tarefa precisa ter um prazo definido. Se o prazo mudar, os lembretes são reagendados automaticamente. Se o prazo for removido, os lembretes são cancelados.
Se a tarefa for cancelada, os lembretes ativos também são cancelados antes do arquivamento.

---

### Gestão

| Comando | O que faz |
|---------|-----------|
| `@Case estender prazo T-001 para 20/03` | Altera prazo (gestor) |
| `@Case limite do Alexandre para 4` | Altera limite WIP da pessoa (gestor) |
| `@Case cadastrar João, telefone 5586999990004, Analista` | Adiciona pessoa (gestor) |
| `@Case remover João` | Remove pessoa (gestor, pede confirmação, reatribui tarefas abertas) |
| `@Case reatribuir T-001 para Rafael` | Muda responsável da tarefa (responsável ou gestor, pede confirmação) |
| `@Case alterar recorrencia R-001 para semanal` | Altera frequência de tarefa recorrente (gestor) |
| `@Case adicionar gestor Maria, telefone 5586999990010` | Adiciona outro gestor com poderes completos (gestor) |
| `@Case adicionar delegado Rafael, telefone 5586999990002` | Adiciona um delegado (gestor) |
| `@Case remover gestor Maria` | Remove um gestor ou delegado (gestor, pede confirmação; o último gestor não pode ser removido) |
| `@Case remover prazo T-001` | Remove prazo da tarefa (gestor) |
| `@Case transferir tarefas do Alexandre para Rafael` | Transfere todas as tarefas ativas de uma pessoa para outra (gestor, pede confirmação) |

---

### Importar de Anexos (PDF/Imagem)

Se a funcionalidade de mídia estiver ativada, você pode criar ou atualizar tarefas enviando documentos:

**Criar tarefas a partir de um anexo:**
```
[Enviar PDF/JPG/PNG]
@Case importar anexo
```

**Atualizar tarefas com base em um anexo:**
```
[Enviar PDF/JPG/PNG]
@Case atualizar tarefas pelo anexo
```

O assistente extrai o texto, mostra uma prévia das mudanças propostas, e só aplica após o comando exato de confirmação:

`CONFIRM_IMPORT {import_action_id}`

Respostas genéricas como `ok`, `confirmado` ou `pode aplicar` não confirmam a importação.

- Formatos aceitos: PDF, JPG, PNG
- Tamanho máximo: 10 MB
- Apenas um gestor pode criar tarefas por anexo
- Não-gestores só podem atualizar tarefas que são seus

---

## Automações

O TaskFlow executa automaticamente 3 rotinas:

Essas rotinas fazem parte do próprio TaskFlow. Para o usuário, elas aparecem apenas como mensagens automáticas do quadro. Você não precisa criar, editar ou gerenciar tarefas do agendador separadamente.

### Standup Matinal

Enviado automaticamente nos dias úteis pela manhã. Mostra:
- Quadro completo por coluna
- Tarefas atrasadas com destaque 🔴
- Resumo por pessoa com status WIP
- Itens no Inbox pendentes de processamento

### Resumo do Gestor (Noite)

Enviado automaticamente nos dias úteis à noite. Consolida:
- 🔥 Tarefas atrasadas
- ⏳ Vencem nas próximas 48h
- 🚧 Bloqueadas/aguardando
- 💤 Sem atualização há 24h+
- ✅ Concluídas hoje
- 3 sugestões de ação

### Revisão Semanal (Sexta)

Revisão GTD completa às sextas. Inclui:
- Resumo: concluídas, criadas, atrasadas na semana
- Inbox pendente de processamento
- Aguardando há 5+ dias (com sugestão de follow-up)
- Tarefas atrasadas (com sugestão de ação)
- Em Andamento sem atualização há 3+ dias
- Prévia da próxima semana (prazos e recorrências)
- Resumo por pessoa na semana

> As automações seguem o fuso horário configurado na instalação. Os horários padrão podem ser ajustados pelo gestor durante a configuração.

> Se o ajuste automático de horário de verão estiver ativado, o TaskFlow mantém o mesmo horário local das automações mesmo quando o fuso muda.

> As automações só enviam mensagens quando há tarefas no quadro. Se não houver tarefas no quadro, a rotina executa silenciosamente.

---

## Permissões

| Ação | Quem pode |
|------|-----------|
| Captura rápida (anotar) | Todos |
| Ajuda (lista de comandos) | Todos |
| Ver quadro / status / detalhes / histórico | Todos |
| Ver `inbox` / `revisao` / `revisao do [pessoa]` / `proxima acao` / `em andamento` | Todos |
| Ver concluídas hoje / esta semana | Todos |
| Minhas tarefas | Todos (identifica pelo remetente) |
| Ver `vencem hoje` / `vencem amanha` / `vencem esta semana` / `proximos 7 dias` | Todos |
| Buscar tarefas por texto | Todos |
| Buscar tarefas por texto + rótulo | Todos |
| Ver tarefas por prioridade ou rótulo | Todos |
| Ver `aguardando do [pessoa]` | Todos |
| Reabrir tarefa concluída | Gestor ou responsável da tarefa |
| Devolver tarefa para fila | Responsável da tarefa |
| Mover próprias tarefas | Responsável da tarefa |
| Marcar sub-etapa como feita | Responsável ou gestor |
| Adicionar / renomear / reabrir sub-etapa | Responsável ou gestor |
| Alterar prioridade da tarefa | Gestor ou responsável da tarefa |
| Adicionar / remover rótulo da tarefa | Gestor ou responsável da tarefa |
| Renomear tarefa | Gestor ou responsável da tarefa |
| Adicionar / editar / remover nota da tarefa | Gestor ou responsável da tarefa |
| Criar tarefa completa / projeto / recorrente | Gestor |
| Processar Inbox | Gestor ou delegado |
| Atualizar próxima ação | Gestor ou responsável da tarefa |
| Aprovar revisão | Gestor ou delegado |
| Rejeitar revisão | Gestor ou delegado |
| Cancelar tarefa | Gestor (com confirmação) |
| Restaurar tarefa arquivada | Gestor |
| Forçar WIP | Gestor |
| Reatribuir tarefa | Responsável ou Gestor (com confirmação) |
| Adicionar/remover pessoa | Gestor |
| Adicionar/remover gestor ou delegado | Gestor |
| Alterar recorrência | Gestor |
| Importar tarefas por anexo | Gestor |
| Atualizar tarefa por anexo | Gestor (qualquer) / Responsável (apenas próprias) |
| Remover prazo | Gestor |
| Ver concluídas do [pessoa] / do mês | Todos |
| Resumo sob demanda | Todos |
| Listar / buscar arquivo | Todos |
| Agenda | Todos |
| Estatísticas | Todos |
| Mudanças (changelog) | Todos |
| Desfazer | Quem fez a ação ou gestor |
| Operações em lote | Mesma permissão do comando individual |
| Atualizar descrição | Gestor ou responsável da tarefa |
| Adicionar / remover dependência | Gestor ou responsável da tarefa |
| Adicionar / remover lembrete | Gestor ou responsável da tarefa |
| Transferir tarefas em lote | Gestor (com confirmação) |
| Criar projeto recorrente | Gestor |
| Criar/remover quadro filho (hierarquia) | Gestor do quadro |
| Vincular/desvincular tarefa a quadro filho (hierarquia) | Gestor do quadro |
| Atualizar rollup (hierarquia) | Gestor do quadro |
| Ver resumo de execução (hierarquia) | Todos |
| Marcar tarefa para o pai (hierarquia) | Gestor ou responsável |

---

## O que o Assistente NÃO Faz

- Não responde perguntas fora do escopo de gestão de tarefas
- Não executa comandos do sistema ou código
- Não modifica suas próprias configurações
- Não envia mensagens individuais (tudo vai para o grupo ou o grupo da pessoa, no modo hierárquico)
- Não acessa arquivos de outros grupos nem o código do sistema

Se você pedir algo fora do escopo, ele responde brevemente que só gerencia tarefas e sugere comandos válidos.

---

## Referência Rápida

```
CAPTURA RÁPIDA
  @Case anotar: [descrição]

CRIAR TAREFA (gestor)
  @Case tarefa para [pessoa]: [descrição] ate [data]
  @Case projeto para [pessoa]: [descrição]. Etapas: 1. ..., 2. ...
  @Case diario para [pessoa]: [descrição]
  @Case semanal para [pessoa]: [descrição] toda [dia da semana]
  @Case mensal para [pessoa]: [descrição] todo dia [N]
  @Case anual para [pessoa]: [descrição] todo dia [D/M]
  @Case projeto recorrente para [pessoa]: [descrição]. Etapas: ... todo [freq]

VER QUADRO
  @Case quadro
  @Case quadro do [pessoa]
  @Case inbox
  @Case revisao
  @Case revisao do [pessoa]
  @Case proxima acao
  @Case em andamento

MOVER TAREFA
  @Case comecando T-XXX
  @Case T-XXX aguardando [motivo]
  @Case T-XXX retomada
  @Case devolver T-XXX
  @Case T-XXX pronta para revisao
  @Case T-XXX aprovada
  @Case T-XXX rejeitada: [motivo]
  @Case reabrir T-XXX
  @Case T-XXX concluida
  @Case adicionar etapa P-XXX: [título]
  @Case renomear etapa P-XXX.N: [novo título]
  @Case reabrir etapa P-XXX.N
  @Case P-XXX.N concluida                (sub-etapa de projeto)
  @Case forcar T-XXX para andamento
  @Case T-XXX, T-YYY, T-ZZZ aprovadas  (operações em lote)
  @Case desfazer

ATUALIZAR TAREFA
  @Case proxima acao T-XXX: [nova ação]
  @Case renomear T-XXX: [novo título]
  @Case prioridade T-XXX: [baixa|normal|alta|urgente]
  @Case rotulo T-XXX: [nome]
  @Case remover rotulo T-XXX: [nome]
  @Case nota T-XXX: [texto]
  @Case editar nota T-XXX #[N]: [novo texto]
  @Case remover nota T-XXX #[N]
  @Case descricao T-XXX: [texto]
  @Case T-XXX depende de T-YYY
  @Case remover dependencia T-XXX de T-YYY
  @Case lembrete T-XXX [N] dia(s) antes
  @Case remover lembrete T-XXX

CONSULTAS
  @Case ajuda
  @Case minhas tarefas
  @Case detalhes T-XXX
  @Case historico T-XXX
  @Case buscar [texto]
  @Case buscar [texto] com rotulo [nome]
  @Case urgentes
  @Case prioridade alta
  @Case rotulo [nome]
  @Case buscar rotulo [nome]
  @Case atrasadas
  @Case concluidas hoje
  @Case concluidas esta semana
  @Case vencem hoje
  @Case vencem amanha
  @Case vencem esta semana
  @Case proximos 7 dias
  @Case o que esta aguardando?
  @Case aguardando do [pessoa]
  @Case concluidas do [pessoa]
  @Case concluidas do mes
  @Case resumo
  @Case listar arquivo
  @Case buscar no arquivo [texto]
  @Case agenda
  @Case agenda da semana
  @Case o que mudou hoje?
  @Case o que mudou esta semana?
  @Case estatisticas
  @Case estatisticas do [pessoa]
  @Case estatisticas do mes

INBOX (gestor ou delegado)
  @Case processar inbox
  @Case T-XXX para [pessoa], prazo [data]

GESTÃO (responsável ou gestor)
  @Case reatribuir T-XXX para [pessoa]

GESTÃO (gestor)
  @Case estender prazo T-XXX para [data]
  @Case cancelar T-XXX
  @Case restaurar T-XXX
  @Case limite do [pessoa] para [N]
  @Case cadastrar [nome], telefone [numero], [cargo]
  @Case remover [nome]
  @Case alterar recorrencia R-XXX para [frequencia]
  @Case adicionar gestor [nome], telefone [numero]
  @Case adicionar delegado [nome], telefone [numero]
  @Case remover gestor [nome]
  @Case remover prazo T-XXX
  @Case transferir tarefas do [pessoa] para [pessoa]

ANEXOS (com mídia ativada)
  @Case importar anexo
  @Case atualizar tarefas pelo anexo
  CONFIRM_IMPORT [import_action_id]

HIERARQUIA (modo hierárquico)
  @Case criar quadro para [pessoa]
  @Case remover quadro do [pessoa]
  @Case vincular T-XXX ao quadro do [pessoa]
  @Case desvincular T-XXX
  @Case atualizar status T-XXX
  @Case resumo de execucao T-XXX
  @Case ligar tarefa ao pai T-XXX
```

---

## Perguntas Frequentes

**Posso mover a tarefa de outra pessoa?**
Não. Apenas o responsável pode mover suas próprias tarefas. O gestor pode forçar movimentações.

**Posso reatribuir uma tarefa minha para outra pessoa?**
Sim. O responsável da tarefa ou qualquer gestor podem reatribuir com `@Case reatribuir T-001 para Rafael`. Não há verificação de limite WIP na reatribuição. Se a tarefa estiver vinculada a um quadro, o vínculo é transferido automaticamente.

**O que acontece se eu tentar começar uma tarefa e estiver no limite WIP?**
O assistente avisa que o limite foi atingido e não move a tarefa. Você precisa concluir ou mover uma tarefa para Aguardando antes de começar outra. O gestor pode forçar com `@Case forcar T-XXX para andamento`.

**Posso pular etapas no quadro (ex: de Inbox direto para Concluída)?**
Sim. O comando `@Case T-XXX concluida` move direto para Concluída de qualquer coluna, mas só pode ser usado pelo responsável da tarefa ou pelo gestor.

**Posso reabrir uma tarefa concluída?**
Sim. Use `@Case reabrir T-001`. O gestor ou o responsável da tarefa podem devolver uma tarefa concluída para Próxima Ação. Se ela já tiver sido arquivada, o gestor usa `@Case restaurar T-001`.

**O que acontece com tarefas recorrentes quando são concluídas?**
Uma nova instância é criada automaticamente com o próximo prazo, baseado na frequência configurada.

**Como sei quem é o gestor?**
O TaskFlow tem pelo menos um gestor de referência (o primeiro gestor registrado). Também pode haver gestores adicionais e delegados. Gestores de referência e adicionais criam tarefas completas e administram a equipe. Delegados ajudam no Inbox e na Revisão.

**Posso ter mais de um quadro do TaskFlow?**
Sim. Você pode usar um grupo único para toda a equipe ou criar grupos separados. Quando há vários grupos, cada grupo tem seu próprio quadro e suas próprias automações.

**Os horários das automações podem mudar?**
Sim. Standup, resumo do gestor e revisão semanal são definidos na instalação e podem ser configurados para outros horários conforme o fuso escolhido.

**Preciso usar o agendador do NanoClaw manualmente?**
Não. As automações do TaskFlow já são configuradas pelo gestor na instalação e funcionam como parte do próprio TaskFlow. Para o usuário, elas aparecem apenas como mensagens automáticas no grupo.

**Como marco uma sub-etapa de projeto como feita?**
Use `@Case P-001.1 concluida` com o ID da sub-etapa (formato pontilhado). O assistente atualiza automaticamente a próxima ação do projeto. Quando todas as sub-etapas forem concluídas, o projeto move para Revisão.

**Posso ajustar as etapas de um projeto depois de criar?**
Sim. Você pode usar `@Case adicionar etapa P-001: ...`, `@Case renomear etapa P-001.2: ...` e `@Case reabrir etapa P-001.2`.

**Posso criar tarefas recorrentes semanais ou diárias?**
Sim. Use `diario`, `semanal`, `mensal` ou `anual` ao criar a tarefa recorrente. Exemplo: `@Case semanal para Rafael: backup do servidor toda segunda`.

**Posso renomear uma tarefa após criá-la?**
Sim. Use `@Case renomear T-001: novo título`. O gestor ou o responsável pela tarefa podem renomear.

**Posso editar ou apagar um comentário da tarefa?**
Sim. Use `@Case editar nota T-001 #2: novo texto` ou `@Case remover nota T-001 #2`. Isso vale para notas novas com ID.

**Comecei uma tarefa mas quero devolver para a fila, como faço?**
Use `@Case devolver T-001`. A tarefa volta para Próxima Ação e libera uma vaga no seu limite WIP.

**Posso ver as tarefas concluídas?**
Sim. Use `@Case concluidas hoje` ou `@Case concluidas esta semana` para ver tarefas finalizadas recentemente.

**Posso buscar uma tarefa por palavra?**
Sim. Use `@Case buscar contrato` (ou qualquer outro texto). O assistente procura em título, próxima ação, aguardando e notas.

**Posso combinar filtros por pessoa ou rótulo?**
Sim. Você pode usar `@Case revisao do Alexandre`, `@Case aguardando do Alexandre`, `@Case buscar rotulo financeiro` e `@Case buscar contrato com rotulo financeiro`.

**Posso marcar tarefas urgentes ou separar por categoria?**
Sim. Use `@Case prioridade T-001: urgente` para destacar urgência e `@Case rotulo T-001: financeiro` para agrupar por tema. Depois você pode consultar com `@Case urgentes`, `@Case prioridade alta` ou `@Case rotulo financeiro`.

**Posso alterar a frequência de uma tarefa recorrente?**
Sim. Um gestor pode usar `@Case alterar recorrencia R-001 para semanal` (aceita: diario, semanal, mensal, anual).

**Como vejo os comandos disponíveis?**
Envie `@Case ajuda` para ver uma lista organizada de todos os comandos.

**Posso desfazer uma ação?**
Sim, use `@Case desfazer` em até 60 segundos. Não funciona para criação, arquivamento ou operações em lote.

**Posso ver tarefas arquivadas?**
Sim. Use `@Case listar arquivo` ou `@Case buscar no arquivo [texto]`.

**Posso ver estatísticas do quadro?**
Sim. Use `@Case estatisticas` para métricas gerais, `@Case estatisticas do Alexandre` para uma pessoa, ou `@Case estatisticas do mes`.

**Posso usar o assistente em mensagem privada?**
Não. Toda interação acontece no grupo do WhatsApp.

**O que é o modo hierárquico?**
É uma forma de organizar quadros em níveis. O gestor raiz pode criar quadros para pessoas da equipe, e cada uma gerencia seu próprio quadro. As tarefas vinculadas recebem atualizações automáticas do quadro filho para o pai.

**Posso ter vários níveis de hierarquia?**
Sim. A profundidade é definida pelo operador durante a instalação (mínimo 2 níveis). Todos os comandos funcionam da mesma forma em qualquer nível.

**O que acontece no quadro folha (último nível)?**
Ele funciona como um quadro normal do TaskFlow — todos os comandos padrão estão disponíveis. A única diferença é que não pode criar sub-quadros nem vincular tarefas para baixo. Pode usar `ligar tarefa ao pai T-XXX` para marcar trabalho como parte de uma entrega do nível acima.

**Posso desvincular uma tarefa que está sendo controlada pelo rollup?**
Sim. O gestor usa `@Case desvincular T-XXX`. A tarefa volta a aceitar movimentação manual normal.

---

## Modo Hierárquico (Delegação)

O TaskFlow pode operar em modo hierárquico, com múltiplos quadros organizados em níveis. Cada pessoa pode ter seu próprio quadro para gerenciar uma equipe abaixo dela.

### Como Funciona

- O quadro raiz (nível 1) é o topo da hierarquia.
- Cada pessoa pode receber um quadro próprio no nível seguinte.
- A profundidade máxima (`max_depth`) define quantos níveis existem (mínimo 2).
- Cada quadro é independente: tem suas próprias tarefas, equipe e automações.
- Dados de todos os quadros ficam em um banco SQLite compartilhado.
- Os mesmos comandos funcionam em qualquer nível — não há comandos diferentes para nível 1, 2 ou 3.

#### Exemplo: Organização com 3 Níveis

```
Nível 1: Quadro do CEO (quadro raiz)
  └── Nível 2: Quadro do VP de Engenharia
        └── Nível 3: Quadro da Gerente Marina (quadro folha)
  └── Nível 2: Quadro do VP de Operações
        └── Nível 3: Quadro do Gerente Lucas (quadro folha)
```

### Criar Quadros Filhos

Quadros filhos são criados automaticamente de duas formas:

1. **Cadastro de nova pessoa**: Quando o gestor usa `@Case cadastrar [nome], telefone [numero], [cargo]` em um quadro não-folha, o quadro filho é provisionado automaticamente.

2. **Atribuição a pessoa desconhecida**: Quando o gestor atribui uma tarefa a alguém que não está cadastrado (ex: `@Case tarefa para João: revisar contrato`), o assistente oferece cadastrar a pessoa. Se o gestor confirmar e fornecer telefone e cargo, o cadastro é feito e o quadro filho é provisionado automaticamente. A tarefa original é atribuída em seguida.

3. **Solicitação explícita**: O gestor pode pedir `@Case criar quadro para [pessoa]`.

Em todos os casos, a pessoa recebe um quadro próprio no nível seguinte, com standup, resumo e revisão semanal configurados automaticamente. Nenhuma intervenção do operador é necessária.

### Resumo Agregado (Rollup)

Quando uma tarefa é vinculada ao quadro de uma pessoa, o quadro pai recebe atualizações automáticas via consulta SQL:

| Status | Significado |
|--------|-------------|
| **Ativo** | Há trabalho em andamento no quadro filho |
| **Bloqueado** | Há itens aguardando no quadro filho |
| **Em risco** | Há itens com prazo vencido |
| **Pronto para revisão** | Todo o trabalho vinculado foi concluído |
| **Aguardando planejamento** | Quadro vinculado mas ainda sem tarefas marcadas |
| **Cancelado** | Trabalho vinculado foi cancelado — precisa de decisão do gestor |

O rollup é sempre entre níveis adjacentes — o nível 1 consulta o nível 2, o nível 2 consulta o nível 3. Nenhum nível acessa quadros mais distantes.

No quadro que recebe a tarefa vinculada, ela continua acionável: a pessoa pode usar os comandos normais (`T-XXX em andamento`, `T-XXX concluida`, etc.) para tocar o trabalho.

Use `@Case atualizar status T-XXX` apenas quando esse mesmo quadro tiver delegado a entrega para um quadro filho e precisar puxar o progresso agregado de volta.

### Comandos de Hierarquia

#### Comandos no quadro pai (gestor)

| Comando | O que faz |
|---------|-----------|
| `@Case criar quadro para [pessoa]` | Solicita criação de quadro para a pessoa |
| `@Case remover quadro do [pessoa]` | Remove registro do quadro filho |
| `@Case vincular T-XXX ao quadro do [pessoa]` | Vincula tarefa ao quadro filho |
| `@Case desvincular T-XXX` | Remove vínculo com quadro filho |
| `@Case atualizar status T-XXX` | Atualiza rollup do quadro filho |
| `@Case resumo de execucao T-XXX` | Mostra resumo do rollup |

#### Comandos no quadro filho

| Comando | O que faz |
|---------|-----------|
| `@Case ligar tarefa ao pai T-XXX` | Marca tarefa local como parte de uma entrega do nível acima |

Tarefas marcadas com `🔗` continuam acionáveis no quadro que as recebeu. Use os comandos normais de fluxo (`T-XXX em andamento`, `T-XXX aguardando`, `T-XXX concluida`, etc.) para avançá-las.

Além desses, todos os comandos normais do TaskFlow continuam funcionando em qualquer quadro da hierarquia: captura rápida, projetos, recorrentes, notas, prioridades, rótulos, dependências, lembretes, etc.

### Notificações entre Grupos

No modo hierárquico, quando uma tarefa é atribuída a uma pessoa no quadro pai, a notificação é enviada para o grupo de trabalho dessa pessoa (o quadro filho), não apenas para o grupo do quadro pai. Isso garante que a pessoa veja a notificação no grupo certo.

### Vínculo Automático

Atribuir e vincular são a mesma operação. Quando uma tarefa é atribuída ou reatribuída a uma pessoa que tem quadro registrado, o assistente vincula automaticamente ao quadro dessa pessoa e informa:

> T-004 vinculada automaticamente ao quadro de Alexandre.

Na reatribuição de uma tarefa vinculada, o vínculo anterior é removido automaticamente e o novo vínculo é criado para o quadro da nova pessoa. Se a nova pessoa não tem quadro, a tarefa fica desvinculada.

O gestor pode desvincular a qualquer momento com `desvincular T-XXX`.

### Regras Importantes

- Tarefas recorrentes (`R-XXX`) não podem ser vinculadas a quadros filhos. Use tarefas simples.
- Enquanto vinculada, a movimentação da tarefa é controlada pelo rollup — o responsável não pode mover manualmente.
- Para retomar controle manual, o gestor precisa desvincular primeiro (`desvincular T-XXX`).
- Se uma tarefa vinculada for reatribuída para outra pessoa, o vínculo anterior é removido e refeito automaticamente para o quadro da nova pessoa (se existir). Se a nova pessoa não tem quadro, a tarefa fica desvinculada.
- A reatribuição pode ser feita pelo responsável da tarefa ou pelo gestor — não é necessário verificar limite WIP.
- Se o gestor rejeitar uma tarefa em revisão que está vinculada, o rollup reseta para "ativo" e o quadro filho é notificado.

### Quadros Folha

Quadros no último nível (`hierarchy_level == max_depth`) são quadros folha. Eles funcionam como quadros normais do TaskFlow com todos os comandos padrão, mas não podem:

- Criar sub-quadros (`criar quadro para ...`)
- Vincular tarefas a quadros filhos (`vincular T-XXX ...`)

Quadros folha podem usar o comando `ligar tarefa ao pai T-XXX` para marcar trabalho como parte de uma entrega do nível acima.

### Marcadores Visuais

Tarefas vinculadas aparecem com `🔗` no quadro:

```
🔗 T-004 Entregar infraestrutura (Alexandre) [active]
```

No standup matinal:
```
T-004 — 🔗 Alexandre: 4 itens ativos, 1 em risco (atualizado 16:00)
```

Se o rollup estiver desatualizado (mais de 24h), o resumo do gestor e a revisão semanal destacam com `⚠️`:
```
T-004 — 🔗 active (⚠️ rollup desatualizado — ultimo refresh ha 36h)
```

### O Assistente na Hierarquia

O assistente opera como papel direto no quadro raiz. Pode receber tarefas diretamente no nível 1, sem precisar de um quadro separado.

### Permissões da Hierarquia

| Ação | Quem pode |
|------|-----------|
| Criar quadro para pessoa | Gestor do quadro |
| Remover quadro de pessoa | Gestor do quadro |
| Vincular tarefa a quadro filho | Gestor do quadro |
| Desvincular tarefa | Gestor do quadro |
| Atualizar rollup | Gestor do quadro |
| Ver resumo de execução | Todos |
| Marcar tarefa para o pai | Gestor ou responsável da tarefa |
