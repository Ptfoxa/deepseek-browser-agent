import { z } from 'zod';
import type { PublicSettings, StoredSettings } from '../../types/messages';

export const SETTINGS_KEY = 'dba_settings_v1';

export const DEFAULT_SETTINGS: StoredSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeoutMs: 60_000,
};

export const SettingsSchema = z
  .object({
    apiKey: z.string().max(512),
    baseUrl: z.string().max(2048),
    model: z.string().max(80),
    timeoutMs: z.number().int().min(5_000).max(120_000),
  })
  .strict();

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class SettingsStore {
  private area: StorageAreaLike;

  constructor(area: StorageAreaLike) {
    this.area = area;
  }

  async load(): Promise<StoredSettings> {
    try {
      const stored = await this.area.get(SETTINGS_KEY);
      const parsed = SettingsSchema.safeParse(stored[SETTINGS_KEY]);
      if (!parsed.success) return { ...DEFAULT_SETTINGS };
      return parsed.data;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(settings: StoredSettings): Promise<void> {
    await this.area.set({ [SETTINGS_KEY]: settings });
  }
}

export function toPublicSettings(settings: StoredSettings): PublicSettings {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    hasApiKey: settings.apiKey.length > 0,
  };
}
