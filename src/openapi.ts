const response = { description: "Successful response" };
const json = (schema: any) => ({
  required: true,
  content: { "application/json": { schema } },
});
export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "TaskFlow API",
    version: "1.0.0",
    description:
      "Workspace-scoped REST API. See README/API.md for payloads, roles and transport.",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "taskflow_session" },
      bearer: { type: "http", scheme: "bearer" },
    },
  },
  security: [{ session: [] }, { bearer: [] }],
  paths: {
    "/auth/register": {
      post: {
        security: [],
        summary: "Register and create personal workspace",
        requestBody: json({
          type: "object",
          required: [
            "username",
            "email",
            "password",
            "confirmPassword",
            "acceptedTerms",
          ],
          properties: {
            username: { type: "string" },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 12 },
            confirmPassword: { type: "string" },
            acceptedTerms: { type: "boolean" },
            native: { type: "boolean" },
          },
        }),
        responses: { 201: response },
      },
    },
    "/auth/login": {
      post: {
        security: [],
        summary: "Login with email",
        requestBody: json({
          type: "object",
          properties: {
            email: { type: "string" },
            password: { type: "string" },
            native: { type: "boolean" },
          },
        }),
        responses: { 200: response },
      },
    },
    "/auth/me": {
      get: { summary: "Current profile", responses: { 200: response } },
    },
    "/workspaces": {
      get: {
        summary: "My workspace memberships",
        responses: { 200: response },
      },
      post: { summary: "Create workspace", responses: { 201: response } },
    },
    "/workspaces/{wid}/tasks": {
      parameters: [
        {
          name: "wid",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      get: { summary: "Paginated tasks", responses: { 200: response } },
      post: { summary: "Create a task", responses: { 201: response } },
    },
    "/workspaces/{wid}/tasks/{tid}": {
      parameters: ["wid", "tid"].map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      })),
      get: { summary: "Task details", responses: { 200: response } },
      patch: {
        summary: "Update task; version required for conflict detection",
        responses: { 200: response, 409: { description: "Version conflict" } },
      },
      delete: { summary: "Delete task", responses: { 200: response } },
    },
    "/recovery/request": {
      post: {
        security: [],
        summary: "Request administrator assistance without account enumeration",
        responses: { 202: response },
      },
    },
    "/reports/{wid}": {
      parameters: [
        {
          name: "wid",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "today",
          in: "query",
          required: true,
          schema: { type: "string", format: "date" },
        },
      ],
      get: {
        summary: "Authorized metrics or CSV",
        responses: { 200: response },
      },
    },
  },
};
