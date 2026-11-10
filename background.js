// Opening the reader never starts a scheduled or background network request.
let opening = false;
chrome.action.onClicked.addListener(async () => {
  if (opening) return;
  opening = true;
  try {
    const url = chrome.runtime.getURL("reader.html");
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["TAB"],
      documentUrls: [url],
    });
    const existing = contexts.find((context) => context.tabId >= 0);
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId >= 0)
        await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (error) {
    console.error("Unable to open the news reader:", error);
  } finally {
    opening = false;
  }
});
