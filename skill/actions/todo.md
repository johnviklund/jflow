# todo

**When**: the developer asks to note something for later ("add a todo",
"remember for later", "future work"), or you find work outside the current
ticket, such as an unrelated bug found mid-implementation or an optional
review improvement. It can run at any point, including in the middle of
another action.

**Run**:

1. When you found the item mid-work, first run
   `scripts/jflow todo route <summary…> --detail "<context>"`. Jev's
   `classify` (item-routing) answers `todo` or `in-scope` for the
   assigned ticket. Weigh it and decide:
   - todo: `scripts/jflow todo add <summary…> --detail "<context>"
     --routing <envelope>`. Against an `in-scope` answer, add `--reason`
     and `--evidence`.
   - in scope: `scripts/jflow decide choose <envelope> --action in-scope
     --by agent`, and handle it within the current ticket. Against a
     `todo` answer, add `--reason` and `--evidence`.
   Below the threshold (`route: ask-human`, exit 1) the developer
   decides; record their words with `--by developer --reason`. The
   `--routing` envelope must be the one `todo route` returned for this
   same item. A review improvement is
   never routed: the fixed rule makes it a todo.
   `scripts/jflow todo add <summary…> --detail "<context>"` records the
   item and prints its id (`TODO-n`). The helper notes which ticket was
   assigned when the item was found. It writes only `jflow/todos.json`:
   no ticket, no progress and no authorization change.
2. `scripts/jflow todo list` shows every recorded item and its status.
3. Only when the developer explicitly decides to bring an item into the
   plan, run
   `scripts/jflow todo promote <id> --note "<their words>"`. The result's
   `addTicketWith` tells you what adds the ticket:
   - `plan`: the breakdown still awaits acceptance. Add the ticket to the
     draft and run `plan write` again.
   - `realign`: the plan is accepted, so adding a ticket is an in-flight
     plan change. Recommend `realign` and let the developer invoke it.
     Never run it yourself.
   Until the ticket exists, `next` lists the item under `promotedTodos`.

**Method**: write the summary so that someone can act on it without this
conversation. Put in `--detail` where the item was seen and how to
reproduce it. Do not start working on the item. Do not widen the current
ticket to cover it. Do not promote it because it looks small or related.
"We should fix that" is not a decision to promote; ask whether they want
it in this plan.

**Report**: say the item was recorded, give its id, and say that it is
outside the plan and authorizes nothing. Then return to what you were
doing, exactly where you left off.
