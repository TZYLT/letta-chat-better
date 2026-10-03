Record that a topic just ended, so the user can later cut the conversation at that boundary.

Call this when the conversation moves from one subject to another: a task is finished, a bug is understood, a decision is made, or the user starts asking about something unrelated. The marker points at the newest message in the context, which is why it is more accurate when you call it soon after the switch rather than several turns later.

What a marker is:
- A label in the conversation's transcript, next to the topics already marked.
- Metadata only. It does not change the context, the system prompt, or the tool declarations, so it never invalidates the provider cache.
- Visible to the user through `/topics`, and usable as a cut point when they trim the conversation.

What a marker is not:
- It never deletes or summarises anything. Only the user trims, and only through `/compact`.
- It does not replace your answer. Write the answer first, then mark.

Frequency:
- Marking is rate limited per user turn. Marking a topic every turn is noise, so a mark too soon after the previous one is refused with the number of user turns left to wait. Five or more user turns apart is comfortable.
- One marker per topic. If two markers land in the same turn the second is absorbed into the first and adds nothing.

Titles:
- Name the topic, not the action: `Auth token refresh bug`, not `Fixed the bug`.
- Keep them short enough to read in a list, and specific enough to find again later.
