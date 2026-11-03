

CREATE TABLE products (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    price DECIMAL(12, 2) NOT NULL,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    CONSTRAINT chk_products_price
        CHECK (price >= 0)
) ENGINE = InnoDB;


CREATE TABLE orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id BIGINT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(12, 2) NOT NULL,
    total DECIMAL(14, 2) NOT NULL,
    status ENUM('created', 'cancelled') NOT NULL DEFAULT 'created',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    INDEX idx_orders_product_id (product_id),
    INDEX idx_orders_created_at (created_at),

    CONSTRAINT chk_orders_quantity
        CHECK (quantity > 0),

    CONSTRAINT chk_orders_unit_price
        CHECK (unit_price >= 0),

    CONSTRAINT chk_orders_total
        CHECK (total >= 0),

    CONSTRAINT fk_orders_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
) ENGINE = InnoDB;


CREATE TABLE idempotency_keys (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(128)
        CHARACTER SET ascii
        COLLATE ascii_bin
        NOT NULL,
    request_hash CHAR(64)
        CHARACTER SET ascii
        COLLATE ascii_bin
        NOT NULL,
    status ENUM('processing', 'completed') NOT NULL
        DEFAULT 'processing',
    response_status SMALLINT UNSIGNED NULL,
    response_body JSON NULL,
    order_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    CONSTRAINT uq_idempotency_key
        UNIQUE (`key`),

    CONSTRAINT chk_idempotency_response_status
        CHECK (
            response_status IS NULL
            OR response_status BETWEEN 100 AND 599
        ),

    CONSTRAINT fk_idempotency_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,

    INDEX idx_idempotency_created_at (created_at)
) ENGINE = InnoDB;
