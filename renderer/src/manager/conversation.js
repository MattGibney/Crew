export function orderedMessages(messages = []) {
  const groups = new Map();
  for (const message of messages) {
    const key = message.turnId || message.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return [...groups.values()].flatMap(group => [...group.filter(item => item.role === 'user'), ...group.filter(item => item.role !== 'user')]);
}
