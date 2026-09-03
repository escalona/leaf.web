export function setRetainedTextContent(element: HTMLElement, textContent: string) {
  const child = element.firstChild;
  if (child?.nodeType === Node.TEXT_NODE && child.nextSibling === null) {
    const text = child as Text;
    if (text.data !== textContent) text.data = textContent;
    return text;
  }
  const text = element.ownerDocument.createTextNode(textContent);
  element.replaceChildren(text);
  return text;
}
