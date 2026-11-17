// Models sometimes emit raw citation syntax instead of Markdown. Sources are
// already available in the source panel; hide these markers in saved/streamed replies.
export function displayMessageText(content: string, role: string) {
  if (role !== 'assistant') return content;
  return content.replace(/【\s*(?:sources?\b|https?:\/\/)[^\n】]*(?:】|$)/giu, '');
}
