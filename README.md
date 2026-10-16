# Fileblocks

Extensão do VS Code para visualizar e editar arquivos estruturados (JSON, YAML, XML, HTML) como blocos.

## Desenvolvimento

```bash
npm install
npm run build      # gera dist/extension.js, dist/webview.js e dist/webview.css
npm run watch      # rebuild automático
npm run typecheck  # checagem de tipos (o esbuild não checa tipos)
npm test           # testes unitários dos adapters (node:test)
```

Para rodar, aperte **F5** no VS Code. Ele abre uma janela de Extension Development Host com a pasta `samples/`.
Abra um arquivo e use o ícone na barra de título, ou clique com o botão direito no explorer e escolha
**Fileblocks: Open in Block Editor**. O editor está registrado com `priority: "option"`, então ele
não substitui o editor de texto padrão.

## Arquitetura

```
src/
  extension.ts                 ativação, registro do editor e dos comandos
  editor/
    BlockEditorProvider.ts     CustomTextEditorProvider: liga o TextDocument à webview
    webviewHtml.ts             HTML da webview (CSP + nonce)
  model/
    block.ts                   modelo de blocos comum a todos os formatos
    messages.ts                protocolo de mensagens host <-> webview
  parsers/
    types.ts                   interface FormatAdapter (parse + applyEdit)
    index.ts                   escolhe o adapter pelo languageId ou pela extensão
    textDiff.ts                reduz uma reescrita do texto ao trecho que mudou
    jsonAdapter.ts             jsonc-parser (edições cirúrgicas que preservam a formatação)
    yamlAdapter.ts             yaml (Document API, preserva comentários)
    xmlAdapter.ts              stub
    htmlAdapter.ts             stub
webview/
  main.ts                      ponto de entrada: estado e mensagens
  render.ts                    renderização dos blocos (DOM puro por enquanto)
  styles.css                   usa as variáveis de tema do VS Code
test/                          testes dos adapters
samples/                       arquivos para testar
```

**Fluxo:** o `TextDocument` é a fonte da verdade, então undo/redo, salvar e o estado "modificado"
funcionam nativamente. A cada mudança no documento, o adapter faz o parse do texto em `Block`s e o host
manda o resultado para a webview. Uma edição na webview vira um `BlockEdit`. O adapter converte esse
edit em `TextChange`s, que são aplicadas como `WorkspaceEdit`.

Os adapters não dependem da API do `vscode`, então são testados com testes unitários puros (`test/`).

## Uso

| Ação | Como |
|---|---|
| Editar valor | Clique no campo e dê Enter (checkbox para booleanos) |
| Adicionar | Botão **+** num objeto/array (o VS Code pergunta a chave e o tipo) |
| Renomear | Duplo clique na chave, botão **✎** ou F2 no handle |
| Remover | Botão **×** ou Delete no handle |
| Reordenar | Arraste pelo handle **⠿** ou Alt+↑/↓ |

Tudo passa pelo documento, então **Ctrl+Z** desfaz qualquer ação.

## Roadmap

- [x] Estrutura, Custom Editor, modelo de blocos
- [x] JSON e YAML: visualizar e editar valores escalares
- [x] Adicionar, remover, renomear e reordenar blocos (drag & drop, Alt+↑/↓)
- [ ] XML e HTML com parser que guarda posições
- [x] Detecção de indentação no JSON
- [ ] YAML multi-documento
- [ ] Mudar o tipo de um valor (ex.: string → number)
- [ ] Ícones (codicons) no lugar dos glifos de texto
- [ ] Sincronizar a seleção entre o bloco e o texto
- [ ] Edição guiada por schema (JSON Schema / XSD)
- [x] Testes unitários dos adapters
- [ ] Framework de UI na webview (avaliar quando a interação crescer)
