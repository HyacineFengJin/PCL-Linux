// Host-owned renderer. Untrusted strings only enter textContent, never HTML,
// URLs, styles, selectors, attributes with script semantics, or component types.
export function renderCards(document, container, cards, onAction) {
  const nodes = cards.map(card => {
    const element = document.createElement('article');
    element.className = 'extension-card';
    const source = document.createElement('p');
    source.className = 'extension-origin';
    source.textContent = `扩展 · 发布者未验证 / Extension · unverified publisher · ${card.extensionName}`;
    const title = document.createElement('h3');
    title.textContent = card.title;
    const body = document.createElement('p');
    body.className = 'extension-body';
    body.textContent = card.text;
    const actions = document.createElement('div');
    actions.className = 'extension-actions';
    for (const action of card.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.disabled = !action.enabled;
      if (!action.enabled) button.title = action.unavailableReason === 'no-selected-instance' ? '没有选中实例' : '对应能力未授权';
      button.addEventListener('click', () => {
        if (!button.disabled) onAction({ extensionId: card.extensionId, cardId: card.id, actionId: action.id });
      });
      actions.append(button);
    }
    element.append(source, title, body, actions);
    return element;
  });
  container.replaceChildren(...nodes);
}
