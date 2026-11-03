export const openApiDocument = {
  openapi: "3.1.0",

  info: {
    title: "Reliable Order API",
    version: "1.0.0",
    description: `
API for managing products and creating orders.

Key features:
- Atomic stock deduction using MySQL transactions.
- Idempotency key to prevent duplicate orders.
- Row-level locking using SELECT FOR UPDATE.
- Request validation using Zod.
    `,
    contact: {
      name: "API Support",
    },
  },

  servers: [
    {
      url: "http://localhost:3000",
      description: "Local Development",
    },
  ],

  tags: [
    {
      name: "Health",
      description: "API and database health checks",
    },
    {
      name: "Products",
      description: "Product management endpoints",
    },
    {
      name: "Orders",
      description: "Order creation and idempotency",
    },
  ],

  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Check API health",
        responses: {
          "200": {
            description: "API is running",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    message: {
                      type: "string",
                      example: "Reliable Order API is running",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/health/db": {
      get: {
        tags: ["Health"],
        summary: "Check database connection",
        responses: {
          "200": {
            description: "Database connected",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    database: { type: "string", example: "connected" },
                  },
                },
              },
            },
          },
          "503": {
            description: "Database unavailable",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },

    "/api/products": {
      get: {
        tags: ["Products"],
        summary: "Get all products",
        description: "Retrieve all available products and their stock.",
        responses: {
          "200": {
            description: "Products retrieved successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Product" },
                    },
                  },
                },
              },
            },
          },
          "500": {
            $ref: "#/components/responses/InternalServerError",
          },
        },
      },
    },
    "/api/orders": {
      post: {
        tags: ["Orders"],
        summary: "Create a new order",
        description: `
Creates an order and deducts product stock atomically.

The Idempotency-Key header is required.

If the same key and payload are submitted again,
the API returns the previously stored response.

Using the same key with a different payload returns 409.
        `,

        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description: "Unique key for identifying this order request.",
            schema: {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
            example: "order-request-abc-123",
          },
        ],

        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateOrderRequest",
              },
              example: {
                productId: 1,
                quantity: 2,
              },
            },
          },
        },

        responses: {
          "201": {
            description: "Order created successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    data: {
                      type: "object",
                      properties: {
                        orderId: { type: "integer", example: 1 },
                        productId: { type: "integer", example: 1 },
                        productName: { type: "string", example: "Mechanical Keyboard" },
                        quantity: { type: "integer", example: 2 },
                        unitPrice: { type: "string", example: "350000.00" },
                        total: { type: "string", example: "700000.00" },
                        status: { type: "string", example: "created" },
                      },
                    },
                  },
                },
                example: {
                  success: true,
                  data: {
                    orderId: 1,
                    productId: 1,
                    productName: "Mechanical Keyboard",
                    quantity: 2,
                    unitPrice: "350000.00",
                    total: "700000.00",
                    status: "created",
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid request body or missing/invalid idempotency key",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },

          "404": {
            description: "Product not found",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },

          "409": {
            description:
              "Insufficient stock or idempotency key reused with a different payload",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },

          "500": {
            $ref: "#/components/responses/InternalServerError",
          },

          "503": {
            description: "Service temporarily unavailable",
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Product: {
        type: "object",
        properties: {
          id: { type: "integer", example: 1 },
          name: { type: "string", example: "Mechanical Keyboard" },
          price: { type: "string", example: "350000.00" },
          stock: { type: "integer", example: 10 },
          created_at: {
            type: "string",
            format: "date-time",
          },
        },
      },

      CreateOrderRequest: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "quantity"],
        properties: {
          productId: {
            type: "integer",
            minimum: 1,
            example: 1,
          },
          quantity: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            example: 2,
          },
        },
      },

      ErrorResponse: {
        type: "object",
        properties: {
          success: {
            type: "boolean",
            example: false,
          },
          error: {
            type: "object",
            properties: {
              code: {
                type: "string",
                example: "INSUFFICIENT_STOCK",
              },
              message: {
                type: "string",
                example: "Insufficient product stock",
              },
            },
          },
        },
      },
    },

    responses: {
      InternalServerError: {
        description: "Unexpected internal server error",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ErrorResponse",
            },
          },
        },
      },
    },
  },
};