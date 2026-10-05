export const TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = "high" | "medium" | "low";

export type SessionTodo = {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  stepId?: string;
};

export type SessionTodoSnapshot = {
  sessionId: string;
  todos: SessionTodo[];
  revision: number;
  updatedAt: number;
};
