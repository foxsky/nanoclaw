# provision-child-board.ts Modifications

When creating the WhatsApp group for the child board, resolve the phone JID before passing it as a participant:

Replace:
```typescript
const result = await deps.createGroup(childGroupName, [
  personPhone + '@s.whatsapp.net',
]);
```

With:
```typescript
const participantJid = deps.resolvePhoneJid
  ? await deps.resolvePhoneJid(personPhone)
  : personPhone + '@s.whatsapp.net';
const result = await deps.createGroup(childGroupName, [participantJid]);
```

This ensures the phone number is resolved to the correct WhatsApp JID format before group creation.

## Child boards don't require trigger

In step 7 (register child group), set `requiresTrigger: false`:

```typescript
deps.registerGroup(childGroupJid, {
  ...
  requiresTrigger: false,  // child boards are personal — no trigger needed
  ...
});
```

Child boards are personal boards where only the assignee is present. They should not require a trigger prefix (e.g. `@Case`) before every message.

## Welcome message on child board creation

After step 12 (send confirmation to parent group), add step 13 to send a welcome message to the new child group and mark `welcome_sent = 1`:

```typescript
// --- 13. Send welcome message to child group ---
try {
  await deps.sendMessage(
    childGroupJid,
    `👋 *Bem-vindo ao ${childGroupName}!*\n\nEste é o seu quadro de tarefas pessoal. Aqui você receberá suas tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para um resumo rápido, \`manual\` para a referência completa ou \`guia rapido\` para começar.`,
    assistantName,
  );
  tfDb
    .prepare('UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?')
    .run(childBoardId);
} catch (err) {
  logger.error({ err }, 'provision_child_board: failed to send welcome message');
}
```

This ensures the new group member sees a welcome immediately after their board is created.
