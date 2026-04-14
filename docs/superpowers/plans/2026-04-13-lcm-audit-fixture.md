# LCM Task 1b Live Ollama Validation — 2026-04-13

Empirical artifact for plan `2026-04-13-lcm-lossless-claw-improvements.md` (rev 4). Running live Ollama calls against production weekly inputs proved that:

1. The new arc-style weekly prompt DOES change output voice (qwen3-coder obeys "do NOT restate each day" — contrary to Codex finding B's "hopeful thinking" framing).
2. The new prompt as-first-shipped (commit `3a1593e`) caused a **pt-BR → English language regression** on both sampled groups — a real bug the substring-only tests could not detect.
3. Adding a `CRITICAL LANGUAGE RULE:` directive at the TOP of each depth-aware prompt (not as a trailing footer) restored pt-BR preservation while keeping the arc-recap voice.

Model: `qwen3-coder:latest` @ `http://192.168.2.13:11434`, `stream: false`, no other options.

## Sample inventory

Production context DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/context/context.db`.

### Reproducible inventory query

```sql
SELECT group_folder, level, COUNT(*)
FROM context_nodes
WHERE summary IS NOT NULL AND pruned_at IS NULL
GROUP BY group_folder, level
ORDER BY group_folder, level;
```

As of 2026-04-13: 21 groups have rollup data. Distribution at each level: 21 monthlies, 21 weeklies, 21 dailies, ~25-500 leaves per group.

### Groups sampled in the live Ollama validation (2 of 21 = ~10%)

| Group | Weekly node ID | Child IDs (explicit) |
|---|---|---|
| `thiago-taskflow` | `weekly:thiago-taskflow:2026-W13` | `daily:thiago-taskflow:2026-03-23`, `2026-03-24`, `2026-03-25`, `2026-03-26`, `2026-03-27` |
| `sec-secti` | `weekly:sec-secti:2026-W14` | `daily:sec-secti:2026-03-30`, `2026-03-31`, `2026-04-01`, `2026-04-02`, `2026-04-03` |

### Reproduction query for the before-snapshots (exact SQL)

```sql
-- BEFORE weekly (produced by old prompt, preserved here):
SELECT summary FROM context_nodes WHERE id = 'weekly:thiago-taskflow:2026-W13';

-- Daily inputs that the weekly rollup consumed:
SELECT summary FROM context_nodes
WHERE parent_id = 'weekly:thiago-taskflow:2026-W13'
ORDER BY time_start;
```

Sample size honesty: **2/21 is ~10%. The monthly-already-works claim is NOT universally proven.** Codex rev 4 was correct to flag this. Future work: repeat this validation across all 21 groups OR at minimum sample 5 random groups after each prompt change.

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

## Task 1c live idempotency proof — 2026-04-13

Task 1c adds `{previous_context}` to the daily prompt (d1-only, matching lossless-claw). The concern from plan rev 2 was drift: feeding the LLM's own summary back each re-rollup could produce "summary of summary of summary" degradation.

Live Ollama run (`qwen3-coder:latest`, `temperature=0.2`, `seed=42`) on the thiago W13 daily-23 children, simulating two consecutive rollups with the same child set:

- **Run 1** (`previous_context = "(none — first rollup for this day)"`): 86 words, 7 bullet lines. Anchors: M10/T14/T16/M11/T76/T77/standups/lembretes.
- **Run 2** (`previous_context = Run 1's output`, same child set, same seed): 79 words, 8 bullet lines. Same anchors, slightly reordered, one added meta-line ("Nenhuma nova tarefa criada além das mencionadas").

**Verdict: no drift.** Word count went DOWN (-7), not up. Content anchors preserved. No "summary of summary" degradation observed. Task 1c safe to deploy.

The one minor observation — Run 2 added a meta-observation line — is expected given the prompt instructs "add new events and refine events whose status changed". On a no-change re-run the model has nothing new to add, so it sometimes comments on the absence of change. Acceptable.

Repeat procedure: `python3 /tmp/lcm-idempotency.py` (saved in session). For production re-verification, re-fetch the daily inputs from prod DB and run the script against a fresh Ollama instance.

## Open items (from Codex rev-4 review)

- **A (late-leaf staleness):** not addressed by Task 1b. Tasks 1a + 1c are un-deferred in plan rev 4.
- **C (sample size):** still small. Ideally sample ALL groups at next rollup cycle.
- **D (output-quality signal loop):** no ongoing automated check. Live-sample validation repeated manually when prompts change is the best we have today.
- **F (Task 2 token accounting):** plan rev 4 specifies `input_child_bytes` instead of `prompt.length`. Implementation guard when Task 2 lands.
