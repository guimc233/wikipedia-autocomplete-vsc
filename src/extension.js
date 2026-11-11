'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { downloadIndex, search } = require('./index');

function activate(context) {
  const directory = context.globalStorageUri.fsPath;
  const indexPath = path.join(directory, 'zhwiki-titles.txt');
  let update;

  async function updateIndex() {
    if (update) return update;
    update = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在下载中文维基百科标题', cancellable: true }, async (progress, token) => {
      try {
        await downloadIndex(directory, token, progress.report.bind(progress));
        vscode.window.showInformationMessage('维基百科标题索引已更新。');
        return true;
      } catch (error) {
        if (!token.isCancellationRequested) vscode.window.showErrorMessage(`无法下载标题索引：${error.message}`);
        return false;
      }
    });
    try { return await update; } finally { update = undefined; }
  }

  async function ensureIndex() {
    try { await fs.access(indexPath); return true; } catch {
      const choice = await vscode.window.showInformationMessage('首次使用需要下载中文维基百科标题索引。', '下载索引');
      return choice === '下载索引' && await updateIndex();
    }
  }

  async function pickTitle(initial) {
    return new Promise(resolve => {
      const picker = vscode.window.createQuickPick();
      picker.title = '选择维基百科条目';
      picker.placeholder = '输入标题前缀以查找条目';
      picker.value = initial;
      picker.matchOnDescription = false;
      let generation = 0, timer, selected;
      async function refresh() {
        const current = ++generation;
        const query = picker.value.trim();
        if (!query) { picker.items = []; picker.busy = false; return; }
        picker.busy = true;
        try {
          const titles = await search(indexPath, query);
          if (current !== generation) return;
          picker.items = titles.map(title => ({ label: title }));
          picker.placeholder = titles.length ? '选择条目，或修改搜索词' : '没有匹配的标题，请修改搜索词';
        } catch (error) {
          if (current === generation) vscode.window.showErrorMessage(`无法读取标题索引：${error.message}`);
        } finally { if (current === generation) picker.busy = false; }
      }
      picker.onDidChangeValue(() => {
        generation++;
        clearTimeout(timer);
        timer = setTimeout(refresh, 100);
      });
      picker.onDidAccept(() => { selected = picker.selectedItems[0]?.label; if (selected) picker.hide(); });
      picker.onDidHide(() => { generation++; clearTimeout(timer); picker.dispose(); resolve(selected); });
      picker.show();
      refresh();
    });
  }

  async function linkSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
      vscode.window.showInformationMessage('请在 Markdown 文件中选中文字。'); return;
    }
    if (editor.selections.length !== 1 || editor.selection.isEmpty || !editor.selection.isSingleLine) {
      vscode.window.showInformationMessage('请选中一段单行文字。'); return;
    }
    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    const label = editor.document.getText(range);
    const version = editor.document.version;
    if (!label.trim()) { vscode.window.showInformationMessage('请选中非空文字。'); return; }
    if (!await ensureIndex()) return;
    if (editor.document.version !== version) { vscode.window.showWarningMessage('文档已更改，请重新选中文字。'); return; }
    const title = await pickTitle(label.trim());
    if (!title) return;
    if (editor.document.isClosed || editor.document.version !== version) {
      vscode.window.showWarningMessage('文档已更改，请重新选中文字。'); return;
    }
    const escaped = label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const url = `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const success = await editor.edit(edit => edit.replace(range, `[${escaped}](${url})`));
    if (!success) vscode.window.showErrorMessage('无法插入链接，请重试。');
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('wikipediaAutocomplete.linkSelection', linkSelection),
    vscode.commands.registerCommand('wikipediaAutocomplete.updateIndex', updateIndex)
  );
}

module.exports = { activate };
