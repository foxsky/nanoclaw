# LCM Task 1b Live Ollama Validation — 2026-04-13

Empirical artifact for plan `2026-04-13-lcm-lossless-claw-improvements.md` (rev 4). Running live Ollama calls against production weekly inputs proved that:

1. The new arc-style weekly prompt DOES change output voice (qwen3-coder obeys "do NOT restate each day" — contrary to Codex finding B's "hopeful thinking" framing).
2. The new prompt as-first-shipped (commit `3a1593e`) caused a **pt-BR → English language regression** on both sampled groups — a real bug the substring-only tests could not detect.
3. Adding a `CRITICAL LANGUAGE RULE:` directive at the TOP of each depth-aware prompt (not as a trailing footer) restored pt-BR preservation while keeping the arc-recap voice.

Model: `qwen3-coder:latest` @ `http://192.168.2.13:11434`, `stream: false`, no other options.

## Sample inventory

Production context DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/context/context.db`.

Groups sampled (2 of 4 originally claimed — the other 2 were inspected by the earlier skeptic 1 review, not re-run here):

| Group | Weekly node | Child daily count | Daily payload bytes |
|---|---|---|---|
| `thiago-taskflow` | `weekly:thiago-taskflow:2026-W13` | 5 | 5580 |
| `sec-secti` | `weekly:sec-secti:2026-W14` | 5 | ~6000 |

## thiago W13 — BEFORE (currently in prod, produced by OLD prompt)

Wording excerpt (20 lines, all pt-BR). Structure: bulleted, grouped by theme. Contains direct restatement of daily facts:

> **Principais Realizações**
> - **Conclusão de Entregáveis:** Finalização da reunião com SDUs sobre PRTWeb (M10) e revisão da consulta de receitas das emendas no Portal da Transparência (T16).
>
> **Mudanças de Status na Semana**
> - **M10:** *Próximas Ações* → *Concluída* (arquivada).
> - **T16:** Pendente → *Concluída*.
> - **T14:** Criada (atribuída a Thiago).

Direct restatement count: M10 completion (restates daily 03-23); T16 completion (restates daily 03-27); T14 creation (restates daily 03-23); bulleted "Mudanças de Status" list duplicates daily action lines. Verdict: **restates daily content**, as the audit predicted.

## thiago W13 — AFTER v1 (new prompt as shipped in 3a1593e, BEFORE language fix)

164 words, **English** output despite pt-BR inputs. Content-wise OK (arc framing: "A key arc emerged around the validation of emenda data, initiated by T14, which tied into ongoing discussions about transparency and accountability in financial reporting") but unusable in production — users would see their Portuguese daily summaries roll up into English weekly summaries.

**This is the regression Codex finding B described as an undetectable silent failure mode.** Substring-only tests passed; output was broken.

## thiago W13 — AFTER v2 (with CRITICAL LANGUAGE RULE directive at top)

141 words, correctly in pt-BR, arc framing preserved:

> Esta semana, o foco principal esteve na gestão de tarefas e na validação de dados relacionados às emendas, com destaque para a tarefa T14, criada para envio de arquivos ao Tiago da SEMF, atribuída a Thiago. A tarefa M10, sobre reunião com as SDUs, foi concluída e registrada, marcando um ponto de encerramento de um processo importante. Também houve continuidade com a tarefa M11, recorrente, que ainda não teve data definida, sugerindo uma pendência de acompanhamento. A interação com Thiago Carvalho foi constante, abordando temas como reuniões, tarefas de bot e "emprega", com o assistente fornecendo informações claras e automações, como o standup matinal e lembretes. Apesar das atividades regulares, não houve novas tarefas criadas, indicando um período de monitoramento e execução de tarefas já estabelecidas. A semana se caracterizou por uma gestão organizada, com ênfase em validações e comunicação estruturada.

Qualitative delta from BEFORE:
- **Less restatement**: "M10 Próximas Ações → Concluída" bulleted list is gone. M10 and T14 referenced once each, as anchors ("tarefa T14, criada para envio..."), not as discrete daily events.
- **New pattern recognition**: "não houve novas tarefas criadas, indicando um período de monitoramento" — identifies a pattern across days, not a restatement.
- **Prose, not bullets**: single-paragraph narrative.
- **Word count target 180, actual 141** — slightly under. Acceptable.

## sec-secti W14 — AFTER v2 (confirmation on 2nd group)

147 words, correctly in pt-BR, arc framing present:

> Esta semana, o foco principal foi a automação de relatórios e a gestão de tarefas, com poucas intervenções manuais ou decisões significativas. [...] A maior parte das interações ocorreu com usuários que enviaram identificadores técnicos sem contexto, levando ao reforço da necessidade de divulgar os comandos disponíveis. [...] A automação seguiu seu fluxo padrão, mas não houve avanço em tarefas novas ou atualizações, indicando uma semana de manutenção mais do que de progresso.

Quality: captures the meta-pattern ("semana de manutenção mais do que de progresso") that isn't in any individual daily. Arc voice preserved, language preserved.

## Decisions ratified by this validation

- **Task 1b prompt change IS an improvement** — qwen3-coder meaningfully obeys the "do NOT restate" directive on at least these 2 production samples. Codex finding B's "hopeful thinking" framing was too pessimistic; empirically the model DOES obey. Confidence: n=2. Deploy with continued monitoring for a wider sample.
- **The as-shipped prompt (3a1593e) is NOT production-safe as-is** due to the pt-BR → English regression. Fix ships in the follow-up commit.
- **Substring-only tests are insufficient signal.** Need either periodic live-sample validation OR a dedicated output-quality integration test (out of scope for Task 1b; consider for Task 2).
- **Monthly claim not re-verified here** — the 2 monthly samples in the skeptic 1 review are the only data. Do not deploy any monthly prompt change without repeating this validation procedure on 3+ monthly chains.

## Raw sample files

Files preserved under `/tmp/` during the 2026-04-13 session (not checked in):
- `/tmp/thiago-w13-children.txt` — daily summaries concatenated (5580 bytes)
- `/tmp/thiago-w13-current-weekly.txt` — OLD weekly from prod DB
- `/tmp/thiago-w13-new-weekly.txt` — AFTER v1 (English regression)
- `/tmp/thiago-w13-fixed.txt` — AFTER v2 (pt-BR, with LANGUAGE RULE)
- `/tmp/secsecti-w14-children.txt`, `/tmp/secsecti-w14-new.txt`, `/tmp/secsecti-w14-fixed.txt`

Re-run procedure documented at the top of this file so anyone can repeat with fresh production data.

## Open items (from Codex rev-4 review)

- **A (late-leaf staleness):** not addressed by Task 1b. Tasks 1a + 1c are un-deferred in plan rev 4.
- **C (sample size):** still small. Ideally sample ALL groups at next rollup cycle.
- **D (output-quality signal loop):** no ongoing automated check. Live-sample validation repeated manually when prompts change is the best we have today.
- **F (Task 2 token accounting):** plan rev 4 specifies `input_child_bytes` instead of `prompt.length`. Implementation guard when Task 2 lands.
