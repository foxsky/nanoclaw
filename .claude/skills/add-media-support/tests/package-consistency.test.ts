import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

function assertFetchLatestMockAlignment(skillDir: string): void {
  const whatsappPath = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts');
  const whatsappTestPath = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts');

  expect(fs.existsSync(whatsappPath)).toBe(true);
  expect(fs.existsSync(whatsappTestPath)).toBe(true);

  const whatsapp = fs.readFileSync(whatsappPath, 'utf-8');
  const whatsappTest = fs.readFileSync(whatsappTestPath, 'utf-8');

  const importsFetchLatest = whatsapp.includes('fetchLatestWaWebVersion');
  const mocksFetchLatest = whatsappTest.includes('fetchLatestWaWebVersion');

  // If whatsapp.ts requires fetchLatestWaWebVersion, test mock must provide it.
  if (importsFetchLatest) {
    expect(mocksFetchLatest).toBe(true);
  }
}

describe('skill modify/test consistency', () => {
  const skillsRoot = path.resolve(__dirname, '..', '..');

  it('voice-transcription whatsapp modify file matches its Baileys mock', () => {
    assertFetchLatestMockAlignment(path.join(skillsRoot, 'add-voice-transcription'));
  });

  it('media-support whatsapp modify file matches its Baileys mock', () => {
    assertFetchLatestMockAlignment(path.join(skillsRoot, 'add-media-support'));
  });
});
