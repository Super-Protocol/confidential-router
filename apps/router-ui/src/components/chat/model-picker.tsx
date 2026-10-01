'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@confidential-router/ui/components/select';
import { formatContextLength, formatPricePer1m } from '../../lib/format';

export interface PickableModel {
  id: string;
  name: string;
  contextLength: number;
  tee: string;
  pricing: { promptPer1m: string; completionPer1m: string };
  endpoint: { hostname: string };
}

export interface ModelPickerProps {
  models: PickableModel[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

/**
 * Which model the thread talks to.
 *
 * Only chat-capable models reach this list — the API decides that, not the
 * screen — and the price is on the row because every message here is billed from
 * the same credits an API call would be. Switching model mid-thread is allowed:
 * the transcript is the user's, and comparing two models on the same question is
 * the demo people actually want.
 */
export function ModelPicker({ models, value, onChange, disabled }: ModelPickerProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full sm:w-80" aria-label="Model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            <span className="flex flex-col items-start">
              <span>{model.name}</span>
              <span className="font-mono text-muted-foreground text-xs">
                {model.tee} · {formatContextLength(model.contextLength)} ctx ·{' '}
                {formatPricePer1m(model.pricing.promptPer1m)} in / {formatPricePer1m(model.pricing.completionPer1m)} out
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
