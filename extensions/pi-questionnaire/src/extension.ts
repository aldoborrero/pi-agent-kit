/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, {
    description: "Available options to choose from",
  }),
  allowOther: Type.Optional(
    Type.Boolean({
      description: "Allow 'Type something' option (default: true)",
    }),
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "Questions to ask the user",
  }),
});

function errorResult(
  message: string,
  questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

export default function questionnaire(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    return {
      systemPrompt:
        "When you need structured clarification from the user, especially multiple questions or explicit option selection, prefer the questionnaire tool over ad-hoc free-form questioning.",
    };
  });

  pi.registerTool({
    name: "questionnaire",
    label: "Ask Structured Questions",
    description:
      "Ask the user one or more structured questions with predefined options and optional free-text input. Prefer this tool over normal conversational questioning when you need multiple clarifications, explicit choices, preference gathering, or confirmation before proceeding. Best for scope, priority, implementation tradeoffs, rollout decisions, and other structured user input. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult(
          "Error: UI not available (running in non-interactive mode)",
        );
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      // Normalize questions with defaults
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
        allowOther: q.allowOther !== false,
      }));

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) => {
          const colors = createUiColors(theme);
          // State
          let currentTab = 0;
          let optionIndex = 0;
          let inputMode = false;
          let inputQuestionId: string | null = null;
          let cachedLines: string[] | undefined;
          const answers = new Map<string, Answer>();

          // Editor for "Type something" option
          const editorTheme: EditorTheme = {
            borderColor: (s) => colors.primary(s),
            selectList: {
              selectedPrefix: (t) => colors.primary(t),
              selectedText: (t) => colors.primary(t),
              description: (t) => colors.meta(t),
              scrollInfo: (t) => colors.subtle(t),
              noMatch: (t) => colors.warning(t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          // Helpers
          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function submit(cancelled: boolean) {
            done({
              questions,
              answers: Array.from(answers.values()),
              cancelled,
            });
          }

          function currentQuestion(): Question | undefined {
            return questions[currentTab];
          }

          function currentOptions(): RenderOption[] {
            const q = currentQuestion();
            if (!q) return [];
            const opts: RenderOption[] = [...q.options];
            if (q.allowOther) {
              opts.push({
                value: "__other__",
                label: "Type something.",
                isOther: true,
              });
            }
            return opts;
          }

          function allAnswered(): boolean {
            return questions.every((q) => answers.has(q.id));
          }

          function advanceAfterAnswer() {
            if (!isMulti) {
              submit(false);
              return;
            }
            if (currentTab < questions.length - 1) {
              currentTab++;
            } else {
              currentTab = questions.length; // Submit tab
            }
            optionIndex = 0;
            refresh();
          }

          function saveAnswer(
            questionId: string,
            value: string,
            label: string,
            wasCustom: boolean,
            index?: number,
          ) {
            answers.set(questionId, {
              id: questionId,
              value,
              label,
              wasCustom,
              index,
            });
          }

          // Editor submit callback
          editor.onSubmit = (value) => {
            if (!inputQuestionId) return;
            const trimmed = value.trim() || "(no response)";
            saveAnswer(inputQuestionId, trimmed, trimmed, true);
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            advanceAfterAnswer();
          };

          function handleInput(data: string) {
            // Input mode: route to editor
            if (inputMode) {
              if (matchesKey(data, Key.escape)) {
                inputMode = false;
                inputQuestionId = null;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            const q = currentQuestion();
            const opts = currentOptions();

            // Tab navigation (multi-question only)
            if (isMulti) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                currentTab = (currentTab + 1) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)
              ) {
                currentTab = (currentTab - 1 + totalTabs) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
            }

            // Submit tab
            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter) && allAnswered()) {
                submit(false);
              } else if (matchesKey(data, Key.escape)) {
                submit(true);
              }
              return;
            }

            // Option navigation
            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }

            // Select option
            if (matchesKey(data, Key.enter) && q) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                inputMode = true;
                inputQuestionId = q.id;
                editor.setText("");
                refresh();
                return;
              }
              saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
              advanceAfterAnswer();
              return;
            }

            // Cancel
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
          }

          function render(width: number): string[] {
            if (cachedLines) return cachedLines;

            const lines: string[] = [];
            const q = currentQuestion();
            const opts = currentOptions();

            // Helper to add truncated line
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            add(colors.primary("─".repeat(width)));

            // Tab bar (multi-question only)
            if (isMulti) {
              const tabs: string[] = ["← "];
              for (let i = 0; i < questions.length; i++) {
                const isActive = i === currentTab;
                const isAnswered = answers.has(questions[i].id);
                const lbl = questions[i].label;
                const box = isAnswered ? "■" : "□";
                const color = isAnswered ? "success" : "muted";
                const text = ` ${box} ${lbl} `;
                const styled = isActive
                  ? theme.bg("selectedBg", colors.text(text))
                  : colors.apply(color, text);
                tabs.push(`${styled} `);
              }
              const canSubmit = allAnswered();
              const isSubmitTab = currentTab === questions.length;
              const submitText = " ✓ Submit ";
              const submitStyled = isSubmitTab
                ? theme.bg("selectedBg", colors.text(submitText))
                : colors.apply(canSubmit ? "success" : "dim", submitText);
              tabs.push(`${submitStyled} →`);
              add(` ${tabs.join("")}`);
              lines.push("");
            }

            // Helper to render options list
            function renderOptions() {
              for (let i = 0; i < opts.length; i++) {
                const opt = opts[i];
                const selected = i === optionIndex;
                const isOther = opt.isOther === true;
                const prefix = selected ? colors.primary("> ") : "  ";
                const color = selected ? "accent" : "text";
                // Mark "Type something" differently when in input mode
                if (isOther && inputMode) {
                  add(prefix + colors.primary(`${i + 1}. ${opt.label} ✎`));
                } else {
                  add(prefix + colors.apply(color, `${i + 1}. ${opt.label}`));
                }
                if (opt.description) {
                  add(`     ${colors.meta(opt.description)}`);
                }
              }
            }

            // Content
            if (inputMode && q) {
              add(colors.text(` ${q.prompt}`));
              lines.push("");
              // Show options for reference
              renderOptions();
              lines.push("");
              add(colors.meta(" Your answer:"));
              for (const line of editor.render(width - 2)) {
                add(` ${line}`);
              }
              lines.push("");
              add(colors.subtle(" Enter to submit • Esc to cancel"));
            } else if (currentTab === questions.length) {
              add(colors.primary(theme.bold(" Ready to submit")));
              lines.push("");
              for (const question of questions) {
                const answer = answers.get(question.id);
                if (answer) {
                  const prefix = answer.wasCustom ? "(wrote) " : "";
                  add(
                    `${colors.meta(` ${question.label}: `)}${
                      colors.text(prefix + answer.label)
                    }`,
                  );
                }
              }
              lines.push("");
              if (allAnswered()) {
                add(colors.success(" Press Enter to submit"));
              } else {
                const missing = questions
                  .filter((q) => !answers.has(q.id))
                  .map((q) => q.label)
                  .join(", ");
                add(colors.warning(` Unanswered: ${missing}`));
              }
            } else if (q) {
              add(colors.text(` ${q.prompt}`));
              lines.push("");
              renderOptions();
            }

            lines.push("");
            if (!inputMode) {
              const help = isMulti
                ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
                : " ↑↓ navigate • Enter select • Esc cancel";
              add(colors.subtle(help));
            }
            add(colors.primary("─".repeat(width)));

            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
          };
        },
      );

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        if (a.wasCustom) {
          return `${qLabel}: user wrote: ${a.label}`;
        }
        return `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      const colors = createUiColors(theme);
      let text = colors.model(theme.bold("questionnaire "));
      text += colors.meta(`${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += colors.subtle(` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      const colors = createUiColors(theme);
      if (details.cancelled) {
        return new Text(colors.warning("Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${colors.success("✓ ")}${colors.primary(a.id)}: ${
            colors.meta("(wrote) ")
          }${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${colors.success("✓ ")}${
          colors.primary(a.id)
        }: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
