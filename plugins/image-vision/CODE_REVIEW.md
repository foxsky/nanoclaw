# Code Review: Image Vision Plugin

## ✅ Pontos Positivos

### Arquitetura
- ✅ **Modularidade:** Código bem separado em módulos com responsabilidades claras
  - `types.ts`: Interfaces TypeScript
  - `downloader.ts`: Lógica de download
  - `cleaner.ts`: Lógica de limpeza
  - `index.ts`: Orquestração
- ✅ **Separation of Concerns:** Cada arquivo tem uma única responsabilidade
- ✅ **Type Safety:** Uso adequado de TypeScript com interfaces bem definidas

### Error Handling
- ✅ **Try-catch em todas as operações críticas**
- ✅ **Retorno de erros estruturados** (`MediaDownloadResult` com campo `error`)
- ✅ **Graceful degradation:** Falhas não crasham o sistema
- ✅ **Validação de inputs:** Checks para `msg.key`, diretórios, etc.

### Segurança
- ✅ **Path traversal protection:** Usa `path.join()` ao invés de concatenação
- ✅ **File system isolation:** Cada grupo tem seu próprio diretório `media/`
- ✅ **Configurável por grupo:** Permite controle fino de permissões

### Performance
- ✅ **Async/await:** Download não bloqueia outras operações
- ✅ **Cleanup automático:** Previne acúmulo de arquivos antigos
- ✅ **Buffer handling eficiente:** Libera memória após salvar

---

## ⚠️ Problemas Encontrados

### 1. 🔴 CRÍTICO: Falta validação de tamanho de arquivo

**Localização:** `downloader.ts` linha 35-73

**Problema:**
```typescript
const buffer = await downloadMediaMessage(...);
// Não verifica o tamanho do buffer antes de salvar
fs.writeFileSync(filePath, buffer);
```

**Impacto:**
- Usuário pode enviar arquivo de 100MB e crashar o sistema
- Pode encher o disco rapidamente
- Vulnerabilidade de DoS (Denial of Service)

**Solução:**
```typescript
const buffer = await downloadMediaMessage(...);

if (!buffer) {
  return { success: false, error: 'Failed to download media: empty buffer' };
}

// ADICIONAR: Validação de tamanho
const maxSize = config.maxFileSize || 10485760; // 10MB
if (buffer.length > maxSize) {
  return {
    success: false,
    error: `File too large: ${buffer.length} bytes (max: ${maxSize} bytes)`,
  };
}

fs.writeFileSync(filePath, buffer);
```

---

### 2. 🟡 MÉDIO: processMessageMedia não recebe config

**Localização:** `index.ts` linha 56-105

**Problema:**
```typescript
export async function processMessageMedia(
  msg: proto.IWebMessageInfo,
  chatJid: string,
  groupFolder: string,
): Promise<string | null> {
  const config = groupConfigs.get(chatJid);
  // config tem maxFileSize, mas não passa para downloadAndSaveMedia
  const result = await downloadAndSaveMedia(msg, mediaInfo);
}
```

**Impacto:**
- `maxFileSize` configurado mas nunca usado
- Cada grupo pode ter limite diferente, mas todos são ignorados

**Solução:**
```typescript
// Em downloadAndSaveMedia, adicionar parâmetro:
export async function downloadAndSaveMedia(
  msg: proto.IWebMessageInfo,
  mediaInfo: MediaMessage,
  maxFileSize?: number, // ADICIONAR
): Promise<MediaDownloadResult>

// Em processMessageMedia, passar config:
const result = await downloadAndSaveMedia(msg, mediaInfo, config.maxFileSize);
```

---

### 3. 🟡 MÉDIO: Cleanup scheduler não tem error handling robusto

**Localização:** `index.ts` linha 110-149

**Problema:**
```typescript
function scheduleMediaCleanup(): void {
  const scheduleNext = () => {
    setTimeout(() => {
      runCleanup(); // Se crashar aqui, para de agendar
      scheduleNext();
    }, msUntilMidnight());
  };
  scheduleNext();
}
```

**Impacto:**
- Se `runCleanup()` lançar exception não-capturada, o scheduler para
- Cleanup nunca mais executa até restart

**Solução:**
```typescript
const scheduleNext = () => {
  setTimeout(() => {
    try {
      runCleanup();
    } catch (err) {
      console.error('[Image Vision Plugin] Cleanup failed:', err);
    } finally {
      scheduleNext(); // Sempre re-agenda
    }
  }, msUntilMidnight());
};
```

---

### 4. 🟡 MÉDIO: Extensões de arquivo podem ser perigosas

**Localização:** `downloader.ts` linha 52-67

**Problema:**
```typescript
if (msg.message?.imageMessage) {
  mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
  ext = mimeType.split('/')[1] || 'jpg'; // Pega diretamente do mimetype
}
```

**Impacto:**
- Se mimetype for malformado: `image/jpeg; charset=utf-8`
- Extensão seria: `jpeg; charset=utf-8` (inválida)
- Pode causar problemas no filesystem

**Solução:**
```typescript
// Whitelist de extensões permitidas
const ALLOWED_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

const ext = ALLOWED_EXTENSIONS[mimeType] || 'bin';
```

---

### 5. 🟢 MENOR: Race condition no cleanup scheduler

**Localização:** `index.ts` linha 134-138

**Problema:**
```typescript
const msUntilMidnight = () => {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // Isso cria meia-noite do próximo dia
  return midnight.getTime() - now.getTime();
};
```

**Observação:**
- Se o processo reiniciar perto da meia-noite, pode agendar para 24h no futuro
- Não é crítico, mas poderia melhorar

**Solução:**
```typescript
// Executar cleanup imediatamente na inicialização
if (groupConfigs.size > 0) {
  setTimeout(runCleanup, 5000); // 5s após inicializar
}
scheduleNext();
```

---

### 6. 🟢 MENOR: Falta logging estruturado

**Problema:**
```typescript
console.log('[Image Vision Plugin] ...');
console.error('[Image Vision Plugin] ...');
```

**Impacto:**
- Dificulta debugging em produção
- Não segue o pattern do logger do NanoClaw

**Solução:**
```typescript
// Importar o logger do core
import { logger } from '../../src/logger.js';

// Usar logger estruturado
logger.info({ groupFolder, mediaType, size }, 'Media downloaded');
logger.error({ error, chatJid }, 'Download failed');
```

---

### 7. 🟢 MENOR: Função getMediaForMessage muito simplista

**Localização:** `index.ts` linha 155-176

**Problema:**
```typescript
return files
  .filter((f) => f.includes(messageId)) // Apenas substring match
  .map((f) => path.join(mediaDir, f));
```

**Impacto:**
- Se messageId for "ABC", pegaria "ABC123" também
- Poderia retornar arquivos não relacionados

**Solução:**
```typescript
return files
  .filter((f) => {
    const [timestamp, id] = f.split('-');
    return id?.startsWith(messageId);
  })
  .map((f) => path.join(mediaDir, f));
```

---

## 📊 Resumo da Revisão

### Severidade dos Problemas:
- 🔴 **1 Crítico:** Falta validação de tamanho (DoS vulnerability)
- 🟡 **3 Médios:** Config não usada, scheduler frágil, extensões não sanitizadas
- 🟢 **3 Menores:** Race condition, logging, substring match

### Qualidade Geral:
**7.5/10** - Código bem estruturado, mas precisa de correções de segurança

### Recomendações de Prioridade:

**P0 - Implementar antes de produção:**
1. ✅ Adicionar validação de `maxFileSize`
2. ✅ Passar config para `downloadAndSaveMedia`
3. ✅ Adicionar try-catch no cleanup scheduler

**P1 - Implementar na próxima versão:**
4. ✅ Whitelist de extensões permitidas
5. ✅ Usar logger estruturado

**P2 - Nice to have:**
6. ⚪ Melhorar `getMediaForMessage`
7. ⚪ Executar cleanup imediatamente no init

---

## 🔧 Patches Recomendados

Vou criar patches para os problemas P0 (críticos) na próxima resposta se solicitado.

---

## ✅ O que está MUITO BOM:

1. **Type safety completo** - Zero uso de `any` desnecessário
2. **Error handling consistente** - Todos os erros retornam estruturas
3. **Modularidade exemplar** - Fácil de testar e manter
4. **Documentação inline** - JSDoc em todas as funções públicas
5. **Graceful degradation** - Falhas não quebram o sistema
6. **Path security** - Nenhum risco de path traversal

---

**Status Final:** Código de boa qualidade, mas **NÃO está pronto para produção** até corrigir o problema P0 de validação de tamanho de arquivo.
