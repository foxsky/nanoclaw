# Security & Stability Patches

Correções para os problemas identificados no CODE_REVIEW.md

## Patch 1: Validação de Tamanho de Arquivo (CRÍTICO)

### downloader.ts - Adicionar validação de maxFileSize

**Antes:**
```typescript
export async function downloadAndSaveMedia(
  msg: proto.IWebMessageInfo,
  mediaInfo: MediaMessage,
): Promise<MediaDownloadResult>
```

**Depois:**
```typescript
export async function downloadAndSaveMedia(
  msg: proto.IWebMessageInfo,
  mediaInfo: MediaMessage,
  maxFileSize?: number, // NOVO parâmetro
): Promise<MediaDownloadResult> {
  try {
    // ... código existente até o download do buffer ...

    const buffer = await downloadMediaMessage(
      msg as any,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: () => Promise.resolve(null as any),
      },
    );

    if (!buffer) {
      return {
        success: false,
        error: 'Failed to download media: empty buffer',
      };
    }

    // NOVO: Validar tamanho do arquivo
    if (maxFileSize && buffer.length > maxFileSize) {
      return {
        success: false,
        error: `File too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB (max: ${(maxFileSize / 1024 / 1024).toFixed(2)}MB)`,
      };
    }

    // ... resto do código continua igual ...
  }
}
```

---

## Patch 2: Passar Config para Download (MÉDIO)

### index.ts - Passar maxFileSize para downloadAndSaveMedia

**Antes:**
```typescript
const result = await downloadAndSaveMedia(msg, mediaInfo);
```

**Depois:**
```typescript
const result = await downloadAndSaveMedia(msg, mediaInfo, config.maxFileSize);
```

---

## Patch 3: Error Handling no Cleanup Scheduler (MÉDIO)

### index.ts - Proteger o scheduler contra crashes

**Antes:**
```typescript
const scheduleNext = () => {
  setTimeout(() => {
    runCleanup();
    scheduleNext();
  }, msUntilMidnight());
};
```

**Depois:**
```typescript
const scheduleNext = () => {
  setTimeout(() => {
    try {
      runCleanup();
    } catch (err) {
      console.error('[Image Vision Plugin] Cleanup failed, will retry:', err);
    } finally {
      scheduleNext(); // Sempre re-agenda mesmo se crashou
    }
  }, msUntilMidnight());
};
```

---

## Patch 4: Whitelist de Extensões (MÉDIO)

### downloader.ts - Sanitizar extensões de arquivo

**Adicionar no topo do arquivo:**
```typescript
// Whitelist de extensões permitidas por mimetype
const ALLOWED_MIMETYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/avi': 'avi',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
```

**Substituir a lógica de extensões (linhas 52-67):**
```typescript
// Determine file extension based on media type
let ext = 'bin'; // default para desconhecidos
let mimeType = 'application/octet-stream';

if (msg.message?.imageMessage) {
  mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
  ext = ALLOWED_MIMETYPES[mimeType] || 'jpg';
} else if (msg.message?.videoMessage) {
  mimeType = msg.message.videoMessage.mimetype || 'video/mp4';
  ext = ALLOWED_MIMETYPES[mimeType] || 'mp4';
} else if (msg.message?.documentMessage) {
  mimeType = msg.message.documentMessage.mimetype || 'application/pdf';
  ext = ALLOWED_MIMETYPES[mimeType] || 'pdf';
}

// Se mimetype não está na whitelist, use extensão genérica
if (!ALLOWED_MIMETYPES[mimeType]) {
  console.warn(`[Image Vision Plugin] Unknown mimetype: ${mimeType}, using generic extension`);
  ext = 'bin';
}
```

---

## Patch 5: Logger Estruturado (MENOR)

### Todos os arquivos - Substituir console por logger

**Adicionar imports:**
```typescript
// No topo de index.ts, downloader.ts, cleaner.ts
import { logger } from '../../src/logger.js';
```

**Substituir:**
```typescript
// Antes
console.log('[Image Vision Plugin] Initialized for X groups');
console.error('[Image Vision Plugin] Failed:', err);

// Depois
logger.info({ groupCount: groupConfigs.size }, 'Image Vision Plugin initialized');
logger.error({ err, chatJid }, 'Image Vision Plugin failed to download media');
```

---

## Aplicação dos Patches

### Método 1: Manual
1. Abra cada arquivo mencionado
2. Aplique as mudanças indicadas
3. Execute `npm run build` para verificar

### Método 2: Patch File (Unix)
```bash
# Criar arquivo de patch
cat > /tmp/image-vision.patch << 'EOF'
[conteúdo dos diffs aqui]
EOF

# Aplicar patch
cd /workspace/project/plugins/image-vision
patch -p1 < /tmp/image-vision.patch
```

### Método 3: Automatizado
Execute o script de patch fornecido (se disponível):
```bash
node scripts/apply-image-vision-patches.js
```

---

## Testes Após Patches

### 1. Testar validação de tamanho
```bash
# Enviar imagem > 10MB via WhatsApp
# Verificar log: "File too large: X.XXmb (max: 10.00MB)"
```

### 2. Testar scheduler resiliente
```bash
# Simular erro no cleanup
# Verificar que scheduler continua rodando
```

### 3. Testar extensões sanitizadas
```bash
# Enviar documento com mimetype malformado
# Verificar que arquivo foi salvo com extensão segura
```

---

## Prioridades

**Aplicar AGORA (antes de produção):**
- ✅ Patch 1: Validação de tamanho (segurança crítica)
- ✅ Patch 2: Passar config (funcionalidade quebrada)
- ✅ Patch 3: Error handling scheduler (estabilidade)

**Aplicar DEPOIS (próxima versão):**
- ⚪ Patch 4: Whitelist extensões (segurança média)
- ⚪ Patch 5: Logger estruturado (qualidade de código)

---

**Estimativa de tempo:** 15-20 minutos para aplicar patches P0
