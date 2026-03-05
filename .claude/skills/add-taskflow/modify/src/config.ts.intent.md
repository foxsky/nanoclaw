# config.ts Modifications

Add `buildTriggerPattern` function. TaskFlow groups use a per-group trigger (e.g. `@Case`) stored in `registered_groups.trigger_pattern`, different from the global `TRIGGER_PATTERN`. This function builds a regex from that per-group trigger string.

Add after the `TRIGGER_PATTERN` export:

```typescript
/** Build a trigger regex from a per-group trigger string (e.g. "@Case" → /^@Case\b/i). */
export function buildTriggerPattern(trigger: string): RegExp {
  const name = trigger.startsWith('@') ? trigger.slice(1) : trigger;
  return new RegExp(`^@${escapeRegex(name)}\\b`, 'i');
}
```

Note: `escapeRegex` should already exist in the file (used by `TRIGGER_PATTERN`). If not, add it:

```typescript
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```
