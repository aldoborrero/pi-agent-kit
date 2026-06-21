# questionnaire

Ask the user one or more structured questions with predefined options and optional free-text input.

## What it is for

Use `questionnaire` when the agent needs structured clarification instead of ad-hoc free-form questioning.

It is especially useful when:
- there are multiple explicit choices
- several clarifications are needed at once
- the user should pick from concrete options
- the agent needs structured confirmation before proceeding

Typical use cases:
- scope selection
- priority selection
- implementation tradeoffs
- rollout decisions
- UX or product preference gathering

## Behavior

- **Single question**: shows a simple list of options
- **Multiple questions**: shows a tabbed questionnaire UI
- Supports optional **free-text input** via “Type something”
- Returns structured answers the agent can consume directly

## Tool

### `questionnaire`

Parameters:
- `questions`: array of questions
  - `id`: unique identifier
  - `label`: short tab label
  - `prompt`: full question text
  - `options`: list of choices
    - `value`: returned value
    - `label`: displayed label
    - `description`: optional help text
  - `allowOther`: whether to allow free-text input

## Example

```ts
questionnaire({
  questions: [
    {
      id: "scope",
      label: "Scope",
      prompt: "Which implementation scope do you want?",
      options: [
        { value: "minimal", label: "Minimal fix" },
        { value: "refactor", label: "Refactor existing code" },
        { value: "full", label: "Full redesign" }
      ],
      allowOther: false
    },
    {
      id: "notes",
      label: "Notes",
      prompt: "Any extra constraints?",
      options: [],
      allowOther: true
    }
  ]
})
```

## Guidance

Prefer a normal conversational question instead when:
- only one tiny clarification is needed
- the answer is naturally open-ended
- structured options would make the interaction worse
