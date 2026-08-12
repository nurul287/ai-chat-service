export type WidgetConfig = {
  color: string;
  position: "bottom-right" | "bottom-left";
};

export type WidgetElements = {
  bubble: HTMLButtonElement;
  panel: HTMLDivElement;
  messageList: HTMLDivElement;
  input: HTMLInputElement;
  form: HTMLFormElement;
};

/** Builds and mounts the widget's DOM, closed by default. Pure DOM — no fetch, no state beyond open/closed. */
export function mountWidget(config: WidgetConfig): WidgetElements {
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.zIndex = "2147483647";
  root.style[config.position === "bottom-right" ? "right" : "left"] = "20px";
  root.style.bottom = "20px";
  root.style.fontFamily = "system-ui, sans-serif";

  const bubble = document.createElement("button");
  bubble.textContent = "💬";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.style.width = "56px";
  bubble.style.height = "56px";
  bubble.style.borderRadius = "50%";
  bubble.style.border = "none";
  bubble.style.background = config.color;
  bubble.style.color = "#fff";
  bubble.style.fontSize = "24px";
  bubble.style.cursor = "pointer";
  bubble.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";

  const panel = document.createElement("div");
  panel.style.display = "none";
  panel.style.flexDirection = "column";
  panel.style.width = "320px";
  panel.style.height = "420px";
  panel.style.marginBottom = "12px";
  panel.style.background = "#fff";
  panel.style.borderRadius = "12px";
  panel.style.boxShadow = "0 4px 24px rgba(0,0,0,0.2)";
  panel.style.overflow = "hidden";

  const messageList = document.createElement("div");
  messageList.style.flex = "1";
  messageList.style.overflowY = "auto";
  messageList.style.padding = "12px";

  const form = document.createElement("form");
  form.style.display = "flex";
  form.style.borderTop = "1px solid #e5e5e5";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a message…";
  input.style.flex = "1";
  input.style.border = "none";
  input.style.padding = "12px";
  input.style.outline = "none";

  form.appendChild(input);
  panel.appendChild(messageList);
  panel.appendChild(form);
  root.appendChild(panel);
  root.appendChild(bubble);
  document.body.appendChild(root);

  bubble.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "flex" : "none";
  });

  return { bubble, panel, messageList, input, form };
}

export function appendMessage(messageList: HTMLDivElement, role: "user" | "assistant", text: string): HTMLDivElement {
  const bubble = document.createElement("div");
  bubble.textContent = text;
  bubble.style.margin = "6px 0";
  bubble.style.padding = "8px 12px";
  bubble.style.borderRadius = "12px";
  bubble.style.maxWidth = "80%";
  bubble.style.whiteSpace = "pre-wrap";
  if (role === "user") {
    bubble.style.marginLeft = "auto";
    bubble.style.background = "#e5e5ea";
  } else {
    bubble.style.background = "#f0f0f5";
  }
  messageList.appendChild(bubble);
  messageList.scrollTop = messageList.scrollHeight;
  return bubble;
}
