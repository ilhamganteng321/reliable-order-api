import { Router } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "../config/database.js";

const router = Router();

interface ProductRow extends RowDataPacket {
  id: number;
  name: string;
  price: string;
  stock: number;
  created_at: Date;
}

router.get("/", async (_req, res, next) => {
  try {
    const [products] = await pool.execute<ProductRow[]>(
      `SELECT id, name, price, stock, created_at
       FROM products
       ORDER BY id ASC`,
    );

    res.status(200).json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
