# TaskFlow — Manual do Usuário

Guia de uso do TaskFlow, o assistente de gestão de tarefas via WhatsApp.

## Como Funciona

O TaskFlow gerencia suas tarefas usando um quadro Kanban com 6 colunas. Toda interação acontece pelo WhatsApp — basta enviar mensagens no grupo.

**Para acionar o assistente**, comece a mensagem com `@Tars` (ou o nome configurado do assistente).

## Configuração Inicial

Na instalação, o gestor define:

- O nome de ativação do assistente (ex.: `@Tars`)
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

O gestor pode forçar com: `@Tars forcar T-XXX para andamento`

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
@Tars anotar: revisar contrato do fornecedor
@Tars lembrar: ligar para o cliente amanhã
@Tars registrar: comprar material de escritório
```

O assistente cria a tarefa no Inbox e responde: `📥 T-001 adicionada ao Inbox`

### Criar Tarefa Completa

Se já tem responsável e prazo, a tarefa vai direto para Próxima Ação:

Somente um gestor pode usar os comandos de criação completa (`tarefa`, `projeto`, `diario`, `semanal`, `mensal`, `anual`).

```
@Tars tarefa para Alexandre: revisar contrato ate sexta
@Tars tarefa para Rafael: configurar servidor ate 15/03
```

### Criar Projeto (com etapas)

```
@Tars projeto para Alexandre: migração do servidor. Etapas: 1. backup dos dados, 2. instalar novo SO, 3. migrar serviços, 4. testes
```

Projetos também podem ser recorrentes. As etapas são reiniciadas automaticamente a cada ciclo:

```
@Tars projeto recorrente para Alexandre: revisão de infraestrutura. Etapas: 1. backup, 2. atualização, 3. testes. todo mensal
```

### Criar Tarefa Recorrente

```
@Tars diario para Alexandre: verificar emails
@Tars semanal para Rafael: backup do servidor toda segunda
@Tars mensal para Laizes: relatório financeiro todo dia 5
@Tars anual para Alexandre: renovar licenças todo dia 15/01
```

---

### Mover Tarefas no Quadro

| Comando | O que faz |
|---------|-----------|
| `@Tars comecando T-001` | Move para Em Andamento (verifica WIP) |
| `@Tars iniciando T-001` | Mesmo que acima |
| `@Tars T-001 aguardando resposta do fornecedor` | Move para Aguardando |
| `@Tars T-001 retomada` | Volta para Em Andamento (verifica WIP) |
| `@Tars devolver T-001` | Devolve de Em Andamento para Próxima Ação (libera WIP) |
| `@Tars T-001 pronta para revisao` | Move para Revisão |
| `@Tars T-001 aprovada` | Move de Revisão para Concluída (gestor ou delegado) |
| `@Tars T-001 rejeitada: ajustar item X` | Devolve de Revisão para Em Andamento com motivo de retrabalho (gestor ou delegado) |
| `@Tars reabrir T-001` | Reabre uma tarefa concluída e devolve para Próxima Ação |
| `@Tars T-001 concluida` | Atalho: move direto para Concluída (responsável ou gestor) |
| `@Tars T-001 feita` | Mesmo que acima |
| `@Tars forcar T-001 para andamento` | Move para Em Andamento ignorando limite WIP (gestor) |
| `@Tars adicionar etapa P-001: validar rollback` | Adiciona uma nova sub-etapa ao final do projeto |
| `@Tars renomear etapa P-001.2: instalar SO atualizado` | Renomeia uma sub-etapa específica do projeto |
| `@Tars reabrir etapa P-001.2` | Reabre uma sub-etapa concluída e recalcula a próxima ação |
| `@Tars P-001.1 concluida` | Marca sub-etapa do projeto como feita e avança a próxima ação |
| `@Tars reatribuir T-001 para Rafael` | Muda o responsável da tarefa (gestor, pede confirmação) |
| `@Tars cancelar T-001` | Cancela e arquiva (gestor, pede confirmação) |
| `@Tars restaurar T-001` | Restaura uma tarefa arquivada para Próxima Ação (gestor) |

### Operações em Lote

Você pode aplicar ações a várias tarefas de uma vez usando IDs separados por vírgula:

```
@Tars T-005, T-006, T-007 aprovadas
@Tars aprovar T-005, T-006, T-007
```

Funciona com: aprovar, rejeitar, concluir, cancelar. Cada tarefa é processada individualmente (mesma permissão e validação). O resultado mostra o status de cada uma.

### Desfazer

Desfaça a última ação em até 60 segundos:

```
@Tars desfazer
```

Limitações: não desfaz criação (use `cancelar`), arquivamento, avanço de recorrência ou operações em lote. Apenas um nível de desfazer (sem cadeia). Efeitos cascata (dependências resolvidas, lembretes cancelados) não são revertidos.

### Fluxo Típico

```
1. Gestor cria tarefa     → @Tars tarefa para Alexandre: revisar contrato ate sexta
2. Responsável começa     → @Tars comecando T-001
3. Fica bloqueado         → @Tars T-001 aguardando aprovação jurídica
4. Desbloqueou            → @Tars T-001 retomada
5. Finalizou              → @Tars T-001 pronta para revisao
6. Gestor aprova          → @Tars T-001 aprovada
```

---

### Consultas

| Comando | O que mostra |
|---------|-------------|
| `@Tars quadro` | Quadro completo com todas as colunas |
| `@Tars status` | Mesmo que quadro |
| `@Tars como esta?` | Mesmo que quadro |
| `@Tars quadro do Alexandre` | Tarefas de uma pessoa específica |
| `@Tars inbox` | Somente itens no Inbox |
| `@Tars revisao` | Somente tarefas em Revisão |
| `@Tars revisao do Alexandre` | Somente tarefas em Revisão de uma pessoa |
| `@Tars proxima acao` | Somente tarefas em Próxima Ação |
| `@Tars em andamento` | Somente tarefas em Em Andamento |
| `@Tars minhas tarefas` | Suas próprias tarefas (identifica pelo remetente) |
| `@Tars detalhes T-001` | Todos os campos da tarefa, notas e últimas 5 ações do histórico |
| `@Tars historico T-001` | Histórico completo da tarefa |
| `@Tars atrasadas` | Tarefas com prazo vencido |
| `@Tars vencem hoje` | Tarefas com prazo para hoje |
| `@Tars vencem amanha` | Tarefas com prazo para amanhã |
| `@Tars vencem esta semana` | Tarefas com prazo até o fim da semana atual |
| `@Tars proximos 7 dias` | Tarefas com prazo nos próximos 7 dias |
| `@Tars buscar contrato` | Busca texto em título, próxima ação, aguardando e notas |
| `@Tars buscar contrato com rotulo financeiro` | Busca texto, mas somente em tarefas com um rótulo específico |
| `@Tars urgentes` | Somente tarefas com prioridade urgente |
| `@Tars prioridade alta` | Somente tarefas com prioridade alta |
| `@Tars rotulo financeiro` | Somente tarefas com um rótulo específico |
| `@Tars buscar rotulo financeiro` | Mesmo filtro por rótulo, com uma forma mais explícita |
| `@Tars concluidas hoje` | Tarefas concluídas hoje |
| `@Tars concluidas esta semana` | Tarefas concluídas na semana atual |
| `@Tars o que esta aguardando?` | Tarefas bloqueadas |
| `@Tars aguardando do Alexandre` | Somente tarefas bloqueadas de uma pessoa |
| `@Tars concluidas do Alexandre` | Tarefas concluídas de uma pessoa específica |
| `@Tars concluidas do mes` / `concluidas este mes` | Tarefas concluídas no mês atual |
| `@Tars resumo` | Resumo sob demanda (formato do resumo do gestor) |
| `@Tars listar arquivo` | 20 tarefas arquivadas mais recentes |
| `@Tars buscar no arquivo contrato` | Busca no arquivo por texto |
| `@Tars agenda` | Agenda dos próximos 14 dias por prazo |
| `@Tars agenda da semana` | Agenda dos próximos 7 dias |
| `@Tars o que mudou hoje?` | Mudanças feitas hoje (timeline) |
| `@Tars o que mudou desde ontem?` | Mudanças desde ontem |
| `@Tars o que mudou esta semana?` | Mudanças da semana atual |
| `@Tars estatisticas` | Estatísticas do quadro (concluídas, tempo médio, tendência) |
| `@Tars estatisticas do Alexandre` | Estatísticas de uma pessoa |
| `@Tars estatisticas do mes` | Estatísticas do mês atual |
| `@Tars ajuda` | Lista de comandos disponíveis |

### Estatísticas

Veja métricas do quadro:

```
@Tars estatisticas
@Tars estatisticas do Alexandre
@Tars estatisticas do mes
```

Inclui: concluídas na semana/mês, tempo médio de ciclo (criação→conclusão), tendência de produtividade (esta semana vs anterior) e detalhamento por pessoa. Usa dados do quadro ativo e do arquivo (até 90 dias).

---

### Processar Inbox

Um gestor ou delegado pode processar itens pendentes no Inbox:

```
@Tars processar inbox
```

O assistente lista cada item e pergunta: responsável, prazo e próxima ação. Após preencher, a tarefa vai para Próxima Ação.

Também pode processar um item específico (gestor ou delegado):

```
@Tars T-001 para Alexandre, prazo sexta
```

### Atualizar Tarefa

```
@Tars proxima acao T-001: enviar email para o cliente
@Tars renomear T-001: título corrigido
@Tars prioridade T-001: alta
@Tars rotulo T-001: financeiro
@Tars remover rotulo T-001: financeiro
@Tars nota T-001: cliente pediu ajuste no item 3
@Tars editar nota T-001 #1: cliente pediu ajuste no item 4
@Tars remover nota T-001 #1
@Tars descricao T-001: texto da descrição
```

A descrição é um texto livre de até 500 caracteres que detalha o escopo da tarefa. Diferente das notas, cada tarefa tem apenas uma descrição. Para alterar, envie o comando novamente com o novo texto.

As notas funcionam como comentários da tarefa: o assistente registra automaticamente um ID (`#1`, `#2`, ...), o texto, quem enviou e quando foi registrado.

Notas novas podem ser editadas e removidas pelo gestor ou pelo responsável:

- `@Tars editar nota T-001 #2: novo texto`
- `@Tars remover nota T-001 #2`

Notas antigas de quadros muito antigos podem aparecer sem ID. Elas continuam visíveis, mas não podem ser editadas.

Prioridades aceitas: `baixa`, `normal`, `alta`, `urgente`.

Rótulos são palavras curtas para agrupar tarefas, como `financeiro`, `cliente-a`, `infra`.

### Dependências

Você pode marcar que uma tarefa depende de outra. As dependências são informativas — não bloqueiam movimentação.

| Comando | O que faz |
|---------|-----------|
| `@Tars T-001 depende de T-002` | Marca que T-001 depende de T-002 |
| `@Tars remover dependencia T-001 de T-002` | Remove a dependência |

Quando uma tarefa bloqueadora é concluída, a dependência é removida automaticamente e o grupo é notificado.

Se você cancelar uma tarefa que bloqueia outras, o assistente avisa antes da confirmação quais tarefas serão destravadas. Depois da confirmação, ele remove essa dependência das tarefas afetadas e avisa o grupo.

O assistente verifica dependências circulares antes de adicionar (ex: se T-002 já depende de T-001, recusa).

### Lembretes de Prazo

Crie lembretes para receber uma notificação N dias antes do prazo:

| Comando | O que faz |
|---------|-----------|
| `@Tars lembrete T-001 3 dias antes` | Cria lembrete 3 dias antes do prazo |
| `@Tars remover lembrete T-001` | Remove todos os lembretes da tarefa |

A tarefa precisa ter um prazo definido. Se o prazo mudar, os lembretes são reagendados automaticamente. Se o prazo for removido, os lembretes são cancelados.
Se a tarefa for cancelada, os lembretes ativos também são cancelados antes do arquivamento.

---

### Gestão

| Comando | O que faz |
|---------|-----------|
| `@Tars estender prazo T-001 para 20/03` | Altera prazo (gestor) |
| `@Tars limite do Alexandre para 4` | Altera limite WIP da pessoa (gestor) |
| `@Tars cadastrar João, telefone 5586999990004, Analista` | Adiciona pessoa (gestor) |
| `@Tars remover João` | Remove pessoa (gestor, pede confirmação, reatribui tarefas abertas) |
| `@Tars reatribuir T-001 para Rafael` | Muda responsável da tarefa (gestor, pede confirmação) |
| `@Tars alterar recorrencia R-001 para semanal` | Altera frequência de tarefa recorrente (gestor) |
| `@Tars adicionar gestor Maria, telefone 5586999990010` | Adiciona outro gestor com poderes completos (gestor) |
| `@Tars adicionar delegado Rafael, telefone 5586999990002` | Adiciona um delegado (gestor) |
| `@Tars remover gestor Maria` | Remove um gestor ou delegado (gestor, pede confirmação; o último gestor não pode ser removido) |
| `@Tars remover prazo T-001` | Remove prazo da tarefa (gestor) |
| `@Tars transferir tarefas do Alexandre para Rafael` | Transfere todas as tarefas ativas de uma pessoa para outra (gestor, pede confirmação) |

---

### Importar de Anexos (PDF/Imagem)

Se a funcionalidade de mídia estiver ativada, você pode criar ou atualizar tarefas enviando documentos:

**Criar tarefas a partir de um anexo:**
```
[Enviar PDF/JPG/PNG]
@Tars importar anexo
```

**Atualizar tarefas com base em um anexo:**
```
[Enviar PDF/JPG/PNG]
@Tars atualizar tarefas pelo anexo
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

> As automações só enviam mensagens quando há tarefas no quadro. Se `tasks[]` estiver vazio no grupo (nenhuma tarefa no quadro), a rotina executa silenciosamente.

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
| Reatribuir tarefa | Gestor (com confirmação) |
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
- Não envia mensagens individuais (tudo vai para o grupo)
- Não acessa arquivos de outros grupos nem o código do sistema

Se você pedir algo fora do escopo, ele responde brevemente que só gerencia tarefas e sugere comandos válidos.

---

## Referência Rápida

```
CAPTURA RÁPIDA
  @Tars anotar: [descrição]

CRIAR TAREFA (gestor)
  @Tars tarefa para [pessoa]: [descrição] ate [data]
  @Tars projeto para [pessoa]: [descrição]. Etapas: 1. ..., 2. ...
  @Tars diario para [pessoa]: [descrição]
  @Tars semanal para [pessoa]: [descrição] toda [dia da semana]
  @Tars mensal para [pessoa]: [descrição] todo dia [N]
  @Tars anual para [pessoa]: [descrição] todo dia [D/M]
  @Tars projeto recorrente para [pessoa]: [descrição]. Etapas: ... todo [freq]

VER QUADRO
  @Tars quadro
  @Tars quadro do [pessoa]
  @Tars inbox
  @Tars revisao
  @Tars revisao do [pessoa]
  @Tars proxima acao
  @Tars em andamento

MOVER TAREFA
  @Tars comecando T-XXX
  @Tars T-XXX aguardando [motivo]
  @Tars T-XXX retomada
  @Tars devolver T-XXX
  @Tars T-XXX pronta para revisao
  @Tars T-XXX aprovada
  @Tars T-XXX rejeitada: [motivo]
  @Tars reabrir T-XXX
  @Tars T-XXX concluida
  @Tars adicionar etapa P-XXX: [título]
  @Tars renomear etapa P-XXX.N: [novo título]
  @Tars reabrir etapa P-XXX.N
  @Tars P-XXX.N concluida                (sub-etapa de projeto)
  @Tars forcar T-XXX para andamento
  @Tars T-XXX, T-YYY, T-ZZZ aprovadas  (operações em lote)
  @Tars desfazer

ATUALIZAR TAREFA
  @Tars proxima acao T-XXX: [nova ação]
  @Tars renomear T-XXX: [novo título]
  @Tars prioridade T-XXX: [baixa|normal|alta|urgente]
  @Tars rotulo T-XXX: [nome]
  @Tars remover rotulo T-XXX: [nome]
  @Tars nota T-XXX: [texto]
  @Tars editar nota T-XXX #[N]: [novo texto]
  @Tars remover nota T-XXX #[N]
  @Tars descricao T-XXX: [texto]
  @Tars T-XXX depende de T-YYY
  @Tars remover dependencia T-XXX de T-YYY
  @Tars lembrete T-XXX [N] dia(s) antes
  @Tars remover lembrete T-XXX

CONSULTAS
  @Tars ajuda
  @Tars minhas tarefas
  @Tars detalhes T-XXX
  @Tars historico T-XXX
  @Tars buscar [texto]
  @Tars buscar [texto] com rotulo [nome]
  @Tars urgentes
  @Tars prioridade alta
  @Tars rotulo [nome]
  @Tars buscar rotulo [nome]
  @Tars atrasadas
  @Tars concluidas hoje
  @Tars concluidas esta semana
  @Tars vencem hoje
  @Tars vencem amanha
  @Tars vencem esta semana
  @Tars proximos 7 dias
  @Tars o que esta aguardando?
  @Tars aguardando do [pessoa]
  @Tars concluidas do [pessoa]
  @Tars concluidas do mes
  @Tars resumo
  @Tars listar arquivo
  @Tars buscar no arquivo [texto]
  @Tars agenda
  @Tars agenda da semana
  @Tars o que mudou hoje?
  @Tars o que mudou esta semana?
  @Tars estatisticas
  @Tars estatisticas do [pessoa]
  @Tars estatisticas do mes

INBOX (gestor ou delegado)
  @Tars processar inbox
  @Tars T-XXX para [pessoa], prazo [data]

GESTÃO (gestor)
  @Tars estender prazo T-XXX para [data]
  @Tars reatribuir T-XXX para [pessoa]
  @Tars cancelar T-XXX
  @Tars restaurar T-XXX
  @Tars limite do [pessoa] para [N]
  @Tars cadastrar [nome], telefone [numero], [cargo]
  @Tars remover [nome]
  @Tars alterar recorrencia R-XXX para [frequencia]
  @Tars adicionar gestor [nome], telefone [numero]
  @Tars adicionar delegado [nome], telefone [numero]
  @Tars remover gestor [nome]
  @Tars remover prazo T-XXX
  @Tars transferir tarefas do [pessoa] para [pessoa]

ANEXOS (com mídia ativada)
  @Tars importar anexo
  @Tars atualizar tarefas pelo anexo
  CONFIRM_IMPORT [import_action_id]

HIERARQUIA (modo hierárquico)
  @Tars criar quadro para [pessoa]
  @Tars remover quadro do [pessoa]
  @Tars vincular T-XXX ao quadro do [pessoa]
  @Tars desvincular T-XXX
  @Tars atualizar status T-XXX
  @Tars resumo de execucao T-XXX
  @Tars ligar tarefa ao pai T-XXX
```

---

## Perguntas Frequentes

**Posso mover a tarefa de outra pessoa?**
Não. Apenas o responsável pode mover suas próprias tarefas. O gestor pode reatribuir ou forçar movimentações.

**O que acontece se eu tentar começar uma tarefa e estiver no limite WIP?**
O assistente avisa que o limite foi atingido e não move a tarefa. Você precisa concluir ou mover uma tarefa para Aguardando antes de começar outra. O gestor pode forçar com `@Tars forcar T-XXX para andamento`.

**Posso pular etapas no quadro (ex: de Inbox direto para Concluída)?**
Sim. O comando `@Tars T-XXX concluida` move direto para Concluída de qualquer coluna, mas só pode ser usado pelo responsável da tarefa ou pelo gestor.

**Posso reabrir uma tarefa concluída?**
Sim. Use `@Tars reabrir T-001`. O gestor ou o responsável da tarefa podem devolver uma tarefa concluída para Próxima Ação. Se ela já tiver sido arquivada, o gestor usa `@Tars restaurar T-001`.

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
Use `@Tars P-001.1 concluida` com o ID da sub-etapa (formato pontilhado). O assistente atualiza automaticamente a próxima ação do projeto. Quando todas as sub-etapas forem concluídas, o projeto move para Revisão.

**Posso ajustar as etapas de um projeto depois de criar?**
Sim. Você pode usar `@Tars adicionar etapa P-001: ...`, `@Tars renomear etapa P-001.2: ...` e `@Tars reabrir etapa P-001.2`.

**Posso criar tarefas recorrentes semanais ou diárias?**
Sim. Use `diario`, `semanal`, `mensal` ou `anual` ao criar a tarefa recorrente. Exemplo: `@Tars semanal para Rafael: backup do servidor toda segunda`.

**Posso renomear uma tarefa após criá-la?**
Sim. Use `@Tars renomear T-001: novo título`. O gestor ou o responsável pela tarefa podem renomear.

**Posso editar ou apagar um comentário da tarefa?**
Sim. Use `@Tars editar nota T-001 #2: novo texto` ou `@Tars remover nota T-001 #2`. Isso vale para notas novas com ID.

**Comecei uma tarefa mas quero devolver para a fila, como faço?**
Use `@Tars devolver T-001`. A tarefa volta para Próxima Ação e libera uma vaga no seu limite WIP.

**Posso ver as tarefas concluídas?**
Sim. Use `@Tars concluidas hoje` ou `@Tars concluidas esta semana` para ver tarefas finalizadas recentemente.

**Posso buscar uma tarefa por palavra?**
Sim. Use `@Tars buscar contrato` (ou qualquer outro texto). O assistente procura em título, próxima ação, aguardando e notas.

**Posso combinar filtros por pessoa ou rótulo?**
Sim. Você pode usar `@Tars revisao do Alexandre`, `@Tars aguardando do Alexandre`, `@Tars buscar rotulo financeiro` e `@Tars buscar contrato com rotulo financeiro`.

**Posso marcar tarefas urgentes ou separar por categoria?**
Sim. Use `@Tars prioridade T-001: urgente` para destacar urgência e `@Tars rotulo T-001: financeiro` para agrupar por tema. Depois você pode consultar com `@Tars urgentes`, `@Tars prioridade alta` ou `@Tars rotulo financeiro`.

**Posso alterar a frequência de uma tarefa recorrente?**
Sim. Um gestor pode usar `@Tars alterar recorrencia R-001 para semanal` (aceita: diario, semanal, mensal, anual).

**Como vejo os comandos disponíveis?**
Envie `@Tars ajuda` para ver uma lista organizada de todos os comandos.

**Posso desfazer uma ação?**
Sim, use `@Tars desfazer` em até 60 segundos. Não funciona para criação, arquivamento ou operações em lote.

**Posso ver tarefas arquivadas?**
Sim. Use `@Tars listar arquivo` ou `@Tars buscar no arquivo [texto]`.

**Posso ver estatísticas do quadro?**
Sim. Use `@Tars estatisticas` para métricas gerais, `@Tars estatisticas do Alexandre` para uma pessoa, ou `@Tars estatisticas do mes`.

**Posso usar o assistente em mensagem privada?**
Não. Toda interação acontece no grupo do WhatsApp.

**O que é o modo hierárquico?**
É uma forma de organizar quadros em níveis. O gestor raiz pode criar quadros para pessoas da equipe, e cada uma gerencia seu próprio quadro. As tarefas vinculadas recebem atualizações automáticas do quadro filho para o pai.

**Posso ter vários níveis de hierarquia?**
Sim. A profundidade é definida pelo operador durante a instalação (mínimo 2 níveis). Todos os comandos funcionam da mesma forma em qualquer nível.

**O que acontece no quadro folha (último nível)?**
Ele funciona como um quadro normal do TaskFlow — todos os comandos padrão estão disponíveis. A única diferença é que não pode criar sub-quadros nem vincular tarefas para baixo. Pode usar `ligar tarefa ao pai T-XXX` para marcar trabalho como parte de uma entrega do nível acima.

**Posso desvincular uma tarefa que está sendo controlada pelo rollup?**
Sim. O gestor usa `@Tars desvincular T-XXX`. A tarefa volta a aceitar movimentação manual normal.

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

Quando o gestor de um quadro pede `@Tars criar quadro para [pessoa]`, o assistente gera uma solicitação de provisionamento. O operador do sistema então completa a criação:

1. Cria o grupo no WhatsApp
2. Registra o grupo no sistema
3. Configura o banco de dados e as automações
4. Reinicia o serviço

A pessoa recebe um quadro próprio no nível seguinte, com standup, resumo e revisão semanal configurados automaticamente.

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

Para atualizar o rollup: `@Tars atualizar status T-XXX`

### Comandos de Hierarquia

#### Comandos no quadro pai (gestor)

| Comando | O que faz |
|---------|-----------|
| `@Tars criar quadro para [pessoa]` | Solicita criação de quadro para a pessoa |
| `@Tars remover quadro do [pessoa]` | Remove registro do quadro filho |
| `@Tars vincular T-XXX ao quadro do [pessoa]` | Vincula tarefa ao quadro filho |
| `@Tars desvincular T-XXX` | Remove vínculo com quadro filho |
| `@Tars atualizar status T-XXX` | Atualiza rollup do quadro filho |
| `@Tars resumo de execucao T-XXX` | Mostra resumo do rollup |

#### Comandos no quadro filho

| Comando | O que faz |
|---------|-----------|
| `@Tars ligar tarefa ao pai T-XXX` | Marca tarefa local como parte de uma entrega do nível acima |

Além desses, todos os comandos normais do TaskFlow continuam funcionando em qualquer quadro da hierarquia: captura rápida, projetos, recorrentes, notas, prioridades, rótulos, dependências, lembretes, etc.

### Vínculo Automático

Quando o gestor atribui uma tarefa a uma pessoa que tem quadro registrado, o assistente oferece vincular automaticamente:

> Alexandre tem um quadro registrado. Vincular T-004 automaticamente? (sim/nao)

O gestor pode desvincular a qualquer momento.

### Regras Importantes

- Tarefas recorrentes (`R-XXX`) não podem ser vinculadas a quadros filhos. Use tarefas simples.
- Enquanto vinculada, a movimentação da tarefa é controlada pelo rollup — o responsável não pode mover manualmente.
- Para retomar controle manual, o gestor precisa desvincular primeiro (`desvincular T-XXX`).
- Se uma tarefa vinculada for reatribuída para outra pessoa, o vínculo anterior é removido. O gestor deve vincular novamente ao quadro da nova pessoa.
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
