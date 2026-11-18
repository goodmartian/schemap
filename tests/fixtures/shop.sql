-- A small online shop in three schemas. The same shop is in shop.prisma; both importers must agree.
-- +goose Up
CREATE SCHEMA auth;
CREATE SCHEMA catalog;
CREATE SCHEMA sales;

CREATE TABLE auth.users (
    id          uuid PRIMARY KEY,
    email       varchar(320) NOT NULL UNIQUE,
    full_name   text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.users IS 'People who can sign in';
COMMENT ON COLUMN auth.users.email IS 'Sign-in address, unique';

CREATE TABLE auth.sessions (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL
);

CREATE TABLE catalog.categories (
    id          integer PRIMARY KEY,
    parent_id   integer REFERENCES catalog.categories (id),
    name        text NOT NULL
);
COMMENT ON COLUMN catalog.categories.parent_id IS 'Empty for a top-level category';

CREATE TABLE catalog.products (
    id           uuid PRIMARY KEY,
    category_id  integer NOT NULL,
    title        text NOT NULL,
    price        numeric(12, 2) NOT NULL CHECK (price >= 0),
    CONSTRAINT products_category_fkey FOREIGN KEY (category_id) REFERENCES catalog.categories (id)
);

CREATE TABLE catalog.product_images (
    product_id  uuid NOT NULL,
    position    integer NOT NULL,
    url         text NOT NULL,
    PRIMARY KEY (product_id, position)
);
ALTER TABLE catalog.product_images ADD CONSTRAINT product_images_product_fkey
    FOREIGN KEY (product_id) REFERENCES catalog.products (id);

CREATE TABLE sales.orders (
    id          uuid PRIMARY KEY,
    buyer_id    uuid NOT NULL REFERENCES auth.users (id),
    status      text NOT NULL DEFAULT 'new',
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sales.orders IS 'One checkout';

CREATE TABLE sales.order_items (
    order_id    uuid NOT NULL REFERENCES sales.orders (id),
    product_id  uuid NOT NULL REFERENCES catalog.products (id),
    quantity    integer NOT NULL,
    unit_price  numeric(12, 2) NOT NULL,
    PRIMARY KEY (order_id, product_id)
);

CREATE TABLE sales.payments (
    id          uuid PRIMARY KEY,
    order_id    uuid NOT NULL REFERENCES sales.orders (id),
    amount      numeric(12, 2) NOT NULL,
    paid_at     timestamptz
);

CREATE TABLE sales.refunds (
    id          uuid PRIMARY KEY,
    order_id    uuid NOT NULL,
    product_id  uuid NOT NULL,
    reason      text
);
-- a later migration: a composite reference and a renamed column
ALTER TABLE sales.refunds
    ADD CONSTRAINT refunds_item_fkey FOREIGN KEY (order_id, product_id) REFERENCES sales.order_items (order_id, product_id),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sales.refunds RENAME COLUMN reason TO note;

CREATE TABLE sales.coupons (code text PRIMARY KEY, percent integer NOT NULL);
DROP TABLE sales.coupons;

-- +goose Down
DROP SCHEMA sales CASCADE;
