'use client';

import { CodeBlock } from '@confidential-router/ui/components/code-block';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@confidential-router/ui/components/tabs';
import { SNIPPET_LANGUAGES, type SnippetOptions, wiringSnippet } from './snippets';

export interface WiringSnippetProps extends SnippetOptions {
  /** Heading id, so the card that wraps this can label it. */
  id?: string;
}

/**
 * The drop-in snippet, one tab per client. Each tab is a whole runnable
 * example rather than a diff, because the thing being demonstrated is that
 * nothing except the base URL changes.
 */
export function WiringSnippet({ id, ...options }: WiringSnippetProps) {
  return (
    <Tabs defaultValue="curl" id={id}>
      <TabsList>
        {SNIPPET_LANGUAGES.map((language) => (
          <TabsTrigger key={language.id} value={language.id}>
            {language.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {SNIPPET_LANGUAGES.map((language) => (
        <TabsContent key={language.id} value={language.id}>
          <CodeBlock
            code={wiringSnippet(language.id, options)}
            copyLabel={`Copy the ${language.label} snippet`}
            data-testid={`wiring-snippet-${language.id}`}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
