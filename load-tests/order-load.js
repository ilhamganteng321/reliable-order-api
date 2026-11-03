import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    order_load_test: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
    },
  },

  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
    checks: ["rate>0.99"],
  },
};

export default function () {
  const productId = 1;
  const quantity = 1;

  const idempotencyKey = `load-${__VU}-${__ITER}`;

  const payload = JSON.stringify({
    productId,
    quantity,
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    tags: {
      endpoint: "create-order",
    },
  };

  const response = http.post(
    `${BASE_URL}/api/orders`,
    payload,
    params,
  );

  check(response, {
    "status is 201": (res) => res.status === 201,
    "response has success true": (res) => {
      try {
        return res.json("success") === true;
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
