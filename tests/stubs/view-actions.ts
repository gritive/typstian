// The header actions a view registered through the `obsidian` stub's
// `addAction`. Reading them is how a test activates one the way a click would.
export function headerActions(view: unknown) {
  return (view as {
    actions: Array<{ icon: string; title: string; callback: () => void }>;
  }).actions;
}
