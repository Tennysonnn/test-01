require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── PRODUCTS ────────────────────────────────────────────────

// GET all products
app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('category_en', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST create product
app.post('/api/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .insert([req.body])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT update product
app.put('/api/products/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE product
app.delete('/api/products/:id', async (req, res) => {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST adjust stock (restock or adjustment)
app.post('/api/products/:id/stock', async (req, res) => {
  const { quantity_change, note, movement_type } = req.body;

  // Get current stock
  const { data: prod, error: fetchErr } = await supabase
    .from('products')
    .select('stock')
    .eq('id', req.params.id)
    .single();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const newStock = Math.max(0, prod.stock + quantity_change);

  const { data, error } = await supabase
    .from('products')
    .update({ stock: newStock })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Log movement
  await supabase.from('stock_movements').insert([{
    product_id: req.params.id,
    movement_type: movement_type || 'adjustment',
    quantity_change,
    note
  }]);

  res.json(data);
});

// ─── SALES ───────────────────────────────────────────────────

// GET all sales (with items)
app.get('/api/sales', async (req, res) => {
  const { data: sales, error } = await supabase
    .from('sales')
    .select('*, sale_items(*)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(sales);
});

// GET single sale
app.get('/api/sales/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('sales')
    .select('*, sale_items(*)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST complete a sale (checkout)
app.post('/api/sales', async (req, res) => {
  const { customer_name, customer_phone, payment_method, amount_received, notes, items } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'No items in cart' });
  }

  // Generate invoice number
  const invoice_no = 'INV-' + Date.now().toString().slice(-6);
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);

  // Create sale record
  const { data: sale, error: saleErr } = await supabase
    .from('sales')
    .insert([{ invoice_no, customer_name, customer_phone, payment_method, total, amount_received, notes }])
    .select()
    .single();
  if (saleErr) return res.status(500).json({ error: saleErr.message });

  // Insert sale items
  const saleItems = items.map(item => ({
    sale_id: sale.id,
    product_id: item.product_id,
    product_name: item.product_name,
    unit: item.unit,
    unit_price: item.unit_price,
    quantity: item.quantity,
    subtotal: item.subtotal
  }));

  const { error: itemsErr } = await supabase.from('sale_items').insert(saleItems);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  // Deduct stock for each item
  for (const item of items) {
    const { data: prod } = await supabase
      .from('products')
      .select('stock')
      .eq('id', item.product_id)
      .single();

    if (prod) {
      const newStock = Math.max(0, prod.stock - item.quantity);
      await supabase.from('products').update({ stock: newStock }).eq('id', item.product_id);
      await supabase.from('stock_movements').insert([{
        product_id: item.product_id,
        movement_type: 'sale',
        quantity_change: -item.quantity,
        note: `Sale ${invoice_no}`
      }]);
    }
  }

  // Return full sale with items
  const { data: fullSale } = await supabase
    .from('sales')
    .select('*, sale_items(*)')
    .eq('id', sale.id)
    .single();

  res.json(fullSale);
});

// ─── DASHBOARD STATS ─────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const [{ data: todaySales }, { data: products }, { data: lowStock }] = await Promise.all([
    supabase.from('sales').select('total').gte('created_at', today),
    supabase.from('products').select('stock, low_stock_alert, price'),
    supabase.from('products').select('*').filter('stock', 'lte', 'low_stock_alert')
  ]);

  const todayRevenue = (todaySales || []).reduce((s, r) => s + parseFloat(r.total), 0);
  const inventoryValue = (products || []).reduce((s, p) => s + p.stock * p.price, 0);
  const lowStockCount = (products || []).filter(p => p.stock <= p.low_stock_alert).length;

  res.json({
    today_revenue: todayRevenue,
    today_sales: (todaySales || []).length,
    inventory_value: inventoryValue,
    low_stock_count: lowStockCount
  });
});

// ─── SERVE APP ────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LongLy Ceiling POS running on port ${PORT}`));
