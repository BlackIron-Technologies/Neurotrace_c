FROM python:3.13-slim
WORKDIR /app
COPY sync-server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY bin/neurotrace_sync /app/neurotrace_sync
RUN useradd --create-home neurotrace && mkdir /data && chown neurotrace /data
USER neurotrace
EXPOSE 9473
VOLUME ["/data"]
ENTRYPOINT ["python", "-m", "neurotrace_sync.http_server", "--host", "0.0.0.0", "--port", "9473", "--database", "/data/server.db"]
