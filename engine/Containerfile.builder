# Build with mvm image build; use the resulting image offline for compilation.
FROM docker.io/emscripten/emsdk:4.0.5 AS emsdk
FROM docker.io/library/debian:bookworm
COPY --from=emsdk /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf bison flex gperf make g++ python3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=emsdk /emsdk /emsdk
ENV EMSDK=/emsdk
ENV PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/20.18.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
