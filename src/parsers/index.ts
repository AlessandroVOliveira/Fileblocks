import { jsonAdapter } from './jsonAdapter';
import { createMarkupAdapter } from './markupAdapter';
import type { FormatAdapter } from './types';
import { yamlAdapter } from './yamlAdapter';

export type { FormatAdapter, ParseResult, TextChange } from './types';

const xmlAdapter = createMarkupAdapter('xml');
const htmlAdapter = createMarkupAdapter('html');

const byLanguageId: Record<string, FormatAdapter> = {
  json: jsonAdapter,
  jsonc: jsonAdapter,
  yaml: yamlAdapter,
  xml: xmlAdapter,
  html: htmlAdapter,
};

const byExtension: Record<string, FormatAdapter> = {
  json: jsonAdapter,
  jsonc: jsonAdapter,
  yaml: yamlAdapter,
  yml: yamlAdapter,
  xml: xmlAdapter,
  html: htmlAdapter,
  htm: htmlAdapter,
};

export function getAdapter(document: { languageId: string; fileName: string }): FormatAdapter | undefined {
  const extension = document.fileName.split('.').pop()?.toLowerCase() ?? '';
  return byLanguageId[document.languageId] ?? byExtension[extension];
}
