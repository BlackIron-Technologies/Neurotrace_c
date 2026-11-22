from .common import (json, os, sys, uuid)

class GraphMixin:
    def get_graph_data(self, top_k: int = 3, sim_threshold: float = 0.40):
        """Return graph data: nodes & edges.

        Nodes: {id, label, text, type, file_path, line, timestamp, priority, status}
        Edges: {source, target, rel, weight}
        rel = manual relation type | 'file' | 'semantic'
        """
        if self.conn is None:
            return {"nodes": [], "edges": []}

        cur = self.conn.cursor()
        cur.execute(
            "SELECT id, text, type, tags, file_path, line, timestamp, priority, status FROM thoughts"
        )
        rows = cur.fetchall()

        # 1.  nodes
        nodes = []
        id_to_row = {}
        for r in rows:
            d = dict(r)
            id_to_row[d["id"]] = d
            node_data = {
                "id": d["id"],
                "label": (d["type"] or "note").capitalize(),
                "text": d["text"] or "",
                "type": d["type"] or "note",
                "file_path": d["file_path"] or "No file associated",
                "line": d["line"],
                "timestamp": d["timestamp"] or "",
            }
            if d.get("priority"):
                node_data["priority"] = d["priority"]
            if d.get("status"):
                node_data["status"] = d["status"]
            nodes.append(node_data)

        edges = []
        # 2. Manual relations
        cur.execute("SELECT id, src, dst, rel, meta FROM relations")
        for r in cur.fetchall():
            edges.append(
                {
                    "id": r["id"],
                    "source": r["src"],
                    "target": r["dst"],
                    "rel": r["rel"] or "manual",
                    "weight": 1.0,
                    "meta": r["meta"],
                }
            )

        # 3. explicit edges: same file & ±30 lines ──────────────
        file_map = {}
        for r in rows:
            if r["file_path"]:
                file_map.setdefault(r["file_path"], []).append(r)
        for f, lst in file_map.items():
            for i in range(len(lst)):
                for j in range(i + 1, len(lst)):
                    if abs((lst[i]["line"] or 0) - (lst[j]["line"] or 0)) <= 30:
                        edges.append(
                            {
                                "source": lst[i]["id"],
                                "target": lst[j]["id"],
                                "rel": "file",
                                "weight": 0.8,
                                "meta": "near-code",
                            }
                        )

        # 4.  semantic edges
        if self.faiss_index and self.model:
            for row in rows:
                sims = self.semantic_search(row["text"], top_k, sim_threshold)
                if isinstance(sims, list):
                    for hit in sims:
                        if isinstance(hit, dict) and "id" in hit:
                            edges.append(
                                {
                                    "source": row["id"],
                                    "target": hit["id"],
                                    "rel": "semantic",
                                    "weight": 0.9,
                                    "meta": "emb",
                                }
                            )

        return {"nodes": nodes, "edges": edges}


    def get_graph_insights(self):
        """Calcula nodos aislados, hubs y comunidades simples."""
        try:
            import networkx as nx
        except ImportError:
            return {"status": "error", "msg": "networkx no instalado"}

        data = self.get_graph_data()
        G = nx.Graph()
        for n in data["nodes"]:
            G.add_node(n["id"])
        for e in data["edges"]:
            G.add_edge(e["source"], e["target"])

        isolated = [n for n in nx.isolates(G)]
        degree_dict = dict(G.degree())  # type: ignore
        hubs = sorted(degree_dict, key=lambda k: degree_dict[k], reverse=True)[:5]

        communities = []
        try:
            communities = list(nx.connected_components(G))
        except:
            pass

        return {
            "isolated": isolated,
            "hubs": hubs,
            "communities": [list(c) for c in communities],
        }


    def save_graph_layout(self, layout_dict):
        """Guarda coordenadas de nodos en JSON para persistir layout."""
        if self.workspace_path is None:
            return {"status": "error", "msg": "Workspace path not set"}

        layout_path = os.path.join(
            self.workspace_path, ".neurotrace", "graph_layout.json"
        )
        try:
            os.makedirs(os.path.dirname(layout_path), exist_ok=True)
            with open(layout_path, "w", encoding="utf-8") as f:
                json.dump(layout_dict, f)
            return {"status": "ok"}
        except Exception as e:
            return {"status": "error", "msg": str(e)}


    def add_relation(self, src, dst, rel, meta=None):
        if self.conn is None:
            return {"status": "error", "msg": "Database not initialized."}
        rid = str(uuid.uuid4())
        cur = self.conn.cursor()
        cur.execute(
            "INSERT INTO relations(id,src,dst,rel,meta) VALUES(?,?,?,?,?)",
            (rid, src, dst, rel or "manual", meta),
        )
        self.conn.commit()
        return {"status": "ok", "id": rid}


    def delete_relation(self, id):
        """Deletes a manual relation by its ID."""
        if self.conn is None:
            return {"status": "error", "msg": "Database not initialized."}
        cur = self.conn.cursor()
        cur.execute("DELETE FROM relations WHERE id = ?", (id,))
        self.conn.commit()
        return {"status": "ok", "id": id}


    def update_edge_type(self, id, rel):
        """Updates the relationship type of a manual edge."""
        if self.conn is None:
            return {
                "status": "error",
                "msg": "Database not initialized. Please run 'init' command first.",
            }
        self.conn.execute("UPDATE relations SET rel=? WHERE id=?", (rel, id))
        self.conn.commit()
        return {"status": "ok"}


    def get_graph_layout(self):
        """Carga las coordenadas de nodos guardadas."""
        if self.workspace_path is None:
            return {}

        layout_path = os.path.join(
            self.workspace_path, ".neurotrace", "graph_layout.json"
        )

        if not os.path.exists(layout_path):
            return {}

        try:
            with open(layout_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading graph layout: {e}", file=sys.stderr)
            return {}
